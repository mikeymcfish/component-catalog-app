import type { Express, Request, Response } from "express";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import multer from "multer";
import { z } from "zod";
import type { IStorage } from "./storage";

const execFileAsync = promisify(execFile);

const MODEL_EXTENSIONS = new Set([".step", ".stp", ".wrl", ".glb"]);
const MAX_SOURCE_SIZE = 50 * 1024 * 1024;
const MAX_GLB_SIZE = 100 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 30_000;
const CONVERTER_SCHEMA_VERSION = "kicad-model-v1";
const GLB_JSON_CHUNK = 0x4e4f534a;

export type Model3dSource = "kicad" | "upload";

export interface ModelAsset {
  assetId: string;
  url: string;
  name: string;
  source: Model3dSource;
}

interface StoredKicadSettings {
  kicadDirectory: string | null;
  modelDirectories: string[];
}

interface IndexedModel {
  id: string;
  absolutePath: string;
  rootPath: string;
  rootLabel: string;
  name: string;
  extension: string;
  relativePath: string;
}

export interface ConversionContext {
  cliPath: string;
  boardPath: string;
  outputPath: string;
}

export type ConversionRunner = (context: ConversionContext) => Promise<void>;

interface ModelAssetServiceOptions {
  uploadsRoot: string;
  storage: IStorage;
  settingsFile?: string;
  tempRoot?: string;
  conversionRunner?: ConversionRunner;
}

const settingsBodySchema = z.object({
  kicadDirectory: z.string().trim().max(1024).nullable().optional(),
  modelDirectories: z.array(z.string().trim().min(1).max(1024)).max(20).optional(),
});

const importBodySchema = z.object({
  modelId: z.string().regex(/^[a-f0-9]{64}$/),
});

const defaultSettings: StoredKicadSettings = {
  kicadDirectory: null,
  modelDirectories: [],
};

function uniqueExistingDirectories(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const directories: string[] = [];

  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    let realPath: string;
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
      realPath = fs.realpathSync(resolved);
    } catch {
      continue;
    }

    const key = process.platform === "win32" ? realPath.toLowerCase() : realPath;
    if (!seen.has(key)) {
      seen.add(key);
      directories.push(realPath);
    }
  }

  return directories;
}

function firstExistingFile(values: Array<string | null | undefined>) {
  for (const value of values) {
    if (!value) continue;
    try {
      const resolved = fs.realpathSync(path.resolve(value));
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Continue through the candidate list.
    }
  }
  return null;
}

function getInstallCandidates() {
  const candidates: string[] = [];
  const programFilesRoots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];

  for (const programFiles of programFilesRoots) {
    if (!programFiles) continue;
    const kicadRoot = path.join(programFiles, "KiCad");
    try {
      const versions = fs.readdirSync(kicadRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      candidates.push(...versions.map(version => path.join(kicadRoot, version)));
    } catch {
      // KiCad is not installed under this Program Files root.
    }
  }

  if (process.platform === "darwin") {
    candidates.push("/Applications/KiCad/KiCad.app/Contents");
  }

  return candidates;
}

function getCliCandidates(installDirectory: string | null) {
  const executable = process.platform === "win32" ? "kicad-cli.exe" : "kicad-cli";
  const values: Array<string | null | undefined> = [process.env.KICAD_CLI_PATH];

  if (installDirectory) {
    try {
      if (fs.statSync(installDirectory).isFile()) values.push(installDirectory);
    } catch {
      // The status response will report that the configured path is unavailable.
    }
    values.push(path.join(installDirectory, "bin", executable));
    values.push(path.join(installDirectory, executable));
    values.push(path.join(installDirectory, "MacOS", executable));
  }

  if (process.platform !== "win32") values.push("/usr/bin/kicad-cli", "/usr/local/bin/kicad-cli");
  return values;
}

function getModelDirectoryCandidates(installDirectory: string | null) {
  const values: Array<string | null | undefined> = [
    process.env.KICAD10_3DMODEL_DIR,
    process.env.KICAD9_3DMODEL_DIR,
    process.env.KICAD8_3DMODEL_DIR,
  ];

  if (installDirectory) {
    values.push(path.join(installDirectory, "share", "kicad", "3dmodels"));
    values.push(path.join(installDirectory, "SharedSupport", "3dmodels"));
    values.push(path.join(installDirectory, "Contents", "SharedSupport", "3dmodels"));
    if (path.basename(installDirectory).toLowerCase() === "3dmodels") values.push(installDirectory);
  }

  if (process.platform !== "win32") {
    values.push("/usr/share/kicad/3dmodels", "/usr/local/share/kicad/3dmodels");
  }

  return values;
}

export function detectKicadInstallation() {
  for (const installDirectory of getInstallCandidates()) {
    const cliPath = firstExistingFile(getCliCandidates(installDirectory));
    const modelDirectories = uniqueExistingDirectories(getModelDirectoryCandidates(installDirectory));
    if (cliPath || modelDirectories.length > 0) {
      return { installDirectory: fs.realpathSync(installDirectory), cliPath, modelDirectories };
    }
  }

  const cliPath = firstExistingFile(getCliCandidates(null));
  const modelDirectories = uniqueExistingDirectories(getModelDirectoryCandidates(null));
  return { installDirectory: null, cliPath, modelDirectories };
}

function isPathInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeDisplayName(value: string) {
  const withoutExtension = path.basename(value, path.extname(value));
  const normalized = withoutExtension.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (normalized || "3D model").slice(0, 200);
}

function hashText(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath: string) {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function readStart(filePath: string, length = 16 * 1024) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function rejectExternalGlbResources(json: Record<string, unknown>) {
  const resources = [json.buffers, json.images];
  for (const collection of resources) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!item || typeof item !== "object") continue;
      const uri = (item as { uri?: unknown }).uri;
      if (typeof uri === "string" && !uri.startsWith("data:")) {
        throw new Error("GLB files must embed all buffers and images");
      }
    }
  }
}

export async function validateGlb(filePath: string) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size < 20 || stat.size > MAX_GLB_SIZE) {
    throw new Error("GLB output is empty, truncated, or too large");
  }

  const handle = await fsp.open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.subarray(0, 4).toString("ascii") !== "glTF") {
      throw new Error("File is not a GLB model");
    }
    if (header.readUInt32LE(4) !== 2) throw new Error("Only GLB version 2 is supported");
    if (header.readUInt32LE(8) !== stat.size) throw new Error("GLB declared length does not match the file");

    let offset = 12;
    let chunkIndex = 0;
    let json: Record<string, unknown> | null = null;
    while (offset < stat.size) {
      if (stat.size - offset < 8) throw new Error("GLB chunk header is truncated");
      const chunkHeader = Buffer.alloc(8);
      const chunkHeaderResult = await handle.read(chunkHeader, 0, chunkHeader.length, offset);
      if (chunkHeaderResult.bytesRead !== chunkHeader.length) throw new Error("GLB chunk header is truncated");

      const chunkLength = chunkHeader.readUInt32LE(0);
      const chunkType = chunkHeader.readUInt32LE(4);
      const chunkDataOffset = offset + 8;
      const nextOffset = chunkDataOffset + chunkLength;
      if (chunkLength % 4 !== 0 || nextOffset > stat.size) {
        throw new Error("GLB chunk length is invalid");
      }

      if (chunkIndex === 0) {
        if (chunkType !== GLB_JSON_CHUNK || chunkLength < 2) {
          throw new Error("GLB does not contain a valid JSON chunk");
        }
        const jsonBuffer = Buffer.alloc(chunkLength);
        const jsonResult = await handle.read(jsonBuffer, 0, chunkLength, chunkDataOffset);
        if (jsonResult.bytesRead !== chunkLength) throw new Error("GLB JSON chunk is truncated");
        try {
          json = JSON.parse(jsonBuffer.toString("utf8").replace(/\u0000+$/g, "").trim()) as Record<string, unknown>;
        } catch {
          throw new Error("GLB JSON chunk is invalid");
        }
      }

      offset = nextOffset;
      chunkIndex += 1;
    }

    if (!json || chunkIndex === 0 || offset !== stat.size) {
      throw new Error("GLB does not contain a valid JSON chunk");
    }

    const asset = json.asset;
    if (!asset || typeof asset !== "object" || (asset as { version?: unknown }).version !== "2.0") {
      throw new Error("GLB asset metadata is missing or unsupported");
    }
    rejectExternalGlbResources(json);
  } finally {
    await handle.close();
  }
}

async function validateSource(filePath: string, extension: string) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error("3D model file is empty");
  if (stat.size > MAX_SOURCE_SIZE) throw new Error("3D model exceeds the 50MB limit");

  if (extension === ".glb") return validateGlb(filePath);

  const text = (await readStart(filePath)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (extension === ".step" || extension === ".stp") {
    const upper = text.toUpperCase();
    if (!upper.includes("ISO-10303-21;") || !upper.includes("HEADER;")) {
      throw new Error("STEP file header is invalid");
    }
    return;
  }

  if (extension === ".wrl" && !/^#VRML\s+V(?:1\.0|2\.0)/i.test(text)) {
    throw new Error("WRL file header is invalid");
  }
}

function createModelBoard(modelPath: string) {
  const normalizedPath = modelPath.replace(/\\/g, "/").replace(/"/g, "\\\"");
  return `(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6))
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (36 "B.SilkS" user "b.silkscreen")
    (37 "F.SilkS" user "f.silkscreen")
    (44 "Edge.Cuts" user)
  )
  (setup (pad_to_mask_clearance 0))
  (footprint "ModelOnly"
    (layer "F.Cu")
    (at 0 0)
    (attr board_only exclude_from_pos_files exclude_from_bom)
    (model "${normalizedPath}"
      (offset (xyz 0 0 0))
      (scale (xyz 1 1 1))
      (rotate (xyz 0 0 0))
    )
  )
)`;
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>) {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class ModelAssetService {
  readonly modelsDirectory: string;
  readonly tempRoot: string;
  readonly settingsFile: string;
  private readonly storage: IStorage;
  private readonly conversionRunner: ConversionRunner;
  private readonly conversionQueue = new Semaphore(2);
  private settings: StoredKicadSettings;
  private modelIndex = new Map<string, IndexedModel>();
  private indexedAt: string | null = null;
  private indexError: string | null = null;
  private indexPromise: Promise<void> | null = null;
  private cliVersionCache = new Map<string, string>();
  private assetBuilds = new Map<string, Promise<void>>();
  private readonly bundledAssetIds = new Set<string>();

  constructor(options: ModelAssetServiceOptions) {
    this.modelsDirectory = path.join(options.uploadsRoot, "models");
    this.tempRoot = options.tempRoot || process.env.MODEL_TEMP_DIR || path.join(os.tmpdir(), "component-catalog-models");
    this.settingsFile = options.settingsFile || process.env.KICAD_SETTINGS_FILE || path.join(
      path.dirname(process.env.STORAGE_FILE || path.join(process.cwd(), "data", "storage.json")),
      "kicad-settings.json",
    );
    this.storage = options.storage;
    this.settings = this.loadSettings();
    this.conversionRunner = options.conversionRunner || this.runKicadConversion.bind(this);
    fs.mkdirSync(this.modelsDirectory, { recursive: true });
    fs.mkdirSync(this.tempRoot, { recursive: true });
  }

  private loadSettings(): StoredKicadSettings {
    try {
      const parsed = settingsBodySchema.safeParse(JSON.parse(fs.readFileSync(this.settingsFile, "utf8")));
      if (parsed.success) {
        return {
          kicadDirectory: parsed.data.kicadDirectory || null,
          modelDirectories: parsed.data.modelDirectories || [],
        };
      }
    } catch {
      // Missing or invalid settings fall back to auto-detection.
    }
    return { ...defaultSettings };
  }

  private getEffectiveSettings() {
    const detected = detectKicadInstallation();
    const configuredDirectory = this.settings.kicadDirectory ? path.resolve(this.settings.kicadDirectory) : null;
    const installDirectory = configuredDirectory || detected.installDirectory;
    const cliPath = firstExistingFile([
      ...getCliCandidates(configuredDirectory),
      configuredDirectory ? null : detected.cliPath,
    ]);
    const modelDirectories = uniqueExistingDirectories([
      ...this.settings.modelDirectories,
      ...getModelDirectoryCandidates(configuredDirectory),
      ...(configuredDirectory ? [] : detected.modelDirectories),
    ]);

    return { detected, installDirectory, cliPath, modelDirectories };
  }

  getStatus() {
    const effective = this.getEffectiveSettings();
    return {
      saved: this.settings,
      detected: effective.detected,
      effective: {
        installDirectory: effective.installDirectory,
        cliPath: effective.cliPath,
        modelDirectories: effective.modelDirectories,
      },
      cliAvailable: Boolean(effective.cliPath),
      modelLibraryAvailable: effective.modelDirectories.length > 0,
      index: {
        count: this.modelIndex.size,
        indexedAt: this.indexedAt,
        indexing: Boolean(this.indexPromise),
        error: this.indexError,
      },
    };
  }

  async updateSettings(input: unknown) {
    const parsed = settingsBodySchema.parse(input);
    const next: StoredKicadSettings = {
      kicadDirectory: parsed.kicadDirectory || null,
      modelDirectories: parsed.modelDirectories || [],
    };

    if (next.kicadDirectory && !path.isAbsolute(next.kicadDirectory)) {
      throw new Error("KiCad directory must be an absolute path");
    }
    for (const directory of next.modelDirectories) {
      if (!path.isAbsolute(directory)) throw new Error("Model directories must use absolute paths");
      try {
        if (!fs.statSync(directory).isDirectory()) throw new Error();
      } catch {
        throw new Error(`Model directory does not exist: ${directory}`);
      }
    }
    if (next.kicadDirectory) {
      try {
        if (!fs.statSync(next.kicadDirectory).isDirectory()) throw new Error();
      } catch {
        throw new Error("KiCad installation directory does not exist");
      }
    }

    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    const temporaryPath = `${this.settingsFile}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporaryPath, JSON.stringify(next, null, 2), "utf8");
    await fsp.rename(temporaryPath, this.settingsFile);
    this.settings = next;
    this.modelIndex.clear();
    this.indexedAt = null;
    this.indexError = null;
    return this.getStatus();
  }

  async reindex() {
    if (this.indexPromise) {
      await this.indexPromise;
      return this.getStatus().index;
    }

    this.indexPromise = this.buildIndex();
    try {
      await this.indexPromise;
    } finally {
      this.indexPromise = null;
    }
    return this.getStatus().index;
  }

  private async buildIndex() {
    const roots = this.getEffectiveSettings().modelDirectories;
    const nextIndex = new Map<string, IndexedModel>();
    this.indexError = null;

    if (roots.length === 0) {
      this.modelIndex = nextIndex;
      this.indexedAt = new Date().toISOString();
      this.indexError = "No KiCad 3D model directories were found";
      return;
    }

    const visit = async (directory: string, rootPath: string, rootLabel: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath, rootPath, rootLabel);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (!MODEL_EXTENSIONS.has(extension)) continue;

        let realPath: string;
        try {
          realPath = await fsp.realpath(absolutePath);
        } catch {
          continue;
        }
        if (!isPathInside(realPath, rootPath)) continue;

        const id = hashText(realPath);
        const relativePath = path.relative(rootPath, realPath).split(path.sep).join("/");
        nextIndex.set(id, {
          id,
          absolutePath: realPath,
          rootPath,
          rootLabel,
          name: escapeDisplayName(entry.name),
          extension: extension.slice(1),
          relativePath,
        });
      }
    };

    for (const root of roots) {
      await visit(root, root, path.basename(root) || path.basename(path.dirname(root)));
    }
    this.modelIndex = nextIndex;
    this.indexedAt = new Date().toISOString();
  }

  async search(query: string, limit: number) {
    if (!this.indexedAt) await this.reindex();
    const normalizedQuery = query.trim().toLowerCase();
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

    const scored = Array.from(this.modelIndex.values()).flatMap(model => {
      const name = model.name.toLowerCase();
      const haystack = `${name} ${model.relativePath.toLowerCase()}`;
      if (!tokens.every(token => haystack.includes(token))) return [];
      let score = 0;
      if (name === normalizedQuery) score += 100;
      if (normalizedQuery && name.startsWith(normalizedQuery)) score += 50;
      if (normalizedQuery && name.includes(normalizedQuery)) score += 25;
      score -= model.relativePath.length / 1000;
      return [{ model, score }];
    });

    scored.sort((left, right) => right.score - left.score || left.model.relativePath.localeCompare(right.model.relativePath));
    return {
      results: scored.slice(0, limit).map(({ model }) => ({
        id: model.id,
        name: model.name,
        extension: model.extension,
        library: model.rootLabel,
        relativePath: model.relativePath,
      })),
      index: this.getStatus().index,
    };
  }

  async importIndexedModel(modelId: string) {
    if (!this.indexedAt) await this.reindex();
    const model = this.modelIndex.get(modelId);
    if (!model) throw new Error("KiCad model was not found; reindex and try again");

    const stat = await fsp.lstat(model.absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Indexed model is no longer a regular file");
    const realPath = await fsp.realpath(model.absolutePath);
    if (!isPathInside(realPath, model.rootPath) || hashText(realPath) !== modelId) {
      throw new Error("Indexed model path is no longer valid");
    }
    return this.createAsset(realPath, path.basename(realPath), "kicad");
  }

  async importUpload(file: Express.Multer.File) {
    try {
      return await this.createAsset(file.path, file.originalname, "upload");
    } finally {
      await fsp.rm(file.path, { force: true });
    }
  }

  /**
   * Publish a trusted, application-bundled GLB without consuming the source
   * file. Bundled assets share the normal content-addressed model cache, but
   * remain pinned so removing the last case association cannot make a future
   * preset point at a missing fallback model.
   */
  async importBundledGlb(filePath: string) {
    const resolvedPath = await fsp.realpath(path.resolve(filePath));
    const asset = await this.createAsset(resolvedPath, path.basename(resolvedPath), "upload");
    this.bundledAssetIds.add(asset.assetId);
    return asset;
  }

  private async getConverterSignature(cliPath: string) {
    const stat = await fsp.stat(cliPath);
    const key = `${cliPath}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.cliVersionCache.get(key);
    if (cached) return cached;

    let version = path.basename(cliPath);
    try {
      const result = await execFileAsync(cliPath, ["--version"], {
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 128 * 1024,
      });
      version = `${result.stdout || result.stderr}`.trim().slice(0, 200) || version;
    } catch {
      const fallback = `${stat.size}:${stat.mtimeMs}`;
      version = `${version}:${fallback}`;
    }
    const signature = hashText(`${CONVERTER_SCHEMA_VERSION}:${version}`);
    this.cliVersionCache.set(key, signature);
    return signature;
  }

  private async createAsset(sourcePath: string, originalName: string, source: Model3dSource): Promise<ModelAsset> {
    const extension = path.extname(originalName).toLowerCase();
    if (!MODEL_EXTENSIONS.has(extension)) throw new Error("Supported model types are STEP, STP, WRL, and GLB");
    await validateSource(sourcePath, extension);

    const sourceHash = await hashFile(sourcePath);
    const effective = this.getEffectiveSettings();
    let converterSignature = "native-glb-v1";
    if (extension !== ".glb") {
      if (!effective.cliPath) throw new Error("KiCad CLI is required to convert STEP or WRL models");
      converterSignature = await this.getConverterSignature(effective.cliPath);
    }
    const assetId = hashText(`${extension}:${sourceHash}:${converterSignature}`);
    const finalPath = path.join(this.modelsDirectory, `${assetId}.glb`);

    try {
      await validateGlb(finalPath);
      return { assetId, url: `/uploads/models/${assetId}.glb`, name: escapeDisplayName(originalName), source };
    } catch {
      // Missing or invalid cached output will be rebuilt below.
    }

    let buildPromise = this.assetBuilds.get(assetId);
    if (!buildPromise) {
      buildPromise = this.conversionQueue.run(async () => {
        try {
          await validateGlb(finalPath);
          return;
        } catch {
          await fsp.rm(finalPath, { force: true });
        }

        const publishPath = path.join(this.modelsDirectory, `${assetId}.${crypto.randomUUID()}.tmp`);
        try {
          if (extension === ".glb") {
            await fsp.copyFile(sourcePath, publishPath);
          } else {
            const workDirectory = await fsp.mkdtemp(path.join(this.tempRoot, "convert-"));
            try {
              const controlledSource = path.join(workDirectory, `source${extension}`);
              const boardPath = path.join(workDirectory, "model.kicad_pcb");
              await fsp.copyFile(sourcePath, controlledSource);
              await fsp.writeFile(boardPath, createModelBoard(controlledSource), "utf8");
              await this.conversionRunner({
                cliPath: effective.cliPath!,
                boardPath,
                outputPath: publishPath,
              });
            } finally {
              await fsp.rm(workDirectory, { recursive: true, force: true });
            }
          }

          await validateGlb(publishPath);
          await fsp.rename(publishPath, finalPath);
        } finally {
          await fsp.rm(publishPath, { force: true });
        }
      });
      this.assetBuilds.set(assetId, buildPromise);
    }

    try {
      await buildPromise;
    } finally {
      if (this.assetBuilds.get(assetId) === buildPromise) this.assetBuilds.delete(assetId);
    }

    return { assetId, url: `/uploads/models/${assetId}.glb`, name: escapeDisplayName(originalName), source };
  }

  private async runKicadConversion(context: ConversionContext) {
    try {
      await execFileAsync(context.cliPath, [
        "pcb", "export", "glb",
        "--output", context.outputPath,
        "--no-board-body",
        context.boardPath,
      ], {
        timeout: CONVERSION_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException & { killed?: boolean }).code;
      if (code === "ETIMEDOUT" || (error as { killed?: boolean }).killed) {
        throw new Error("KiCad conversion timed out after 30 seconds");
      }
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(stderr ? `KiCad conversion failed: ${stderr.slice(0, 500)}` : "KiCad conversion failed");
    }
  }

  async deleteAsset(assetId: string) {
    if (!/^[a-f0-9]{64}$/.test(assetId)) throw new Error("Invalid model asset ID");
    if (this.bundledAssetIds.has(assetId)) {
      return { deleted: false, referenced: true };
    }

    const url = `/uploads/models/${assetId}.glb`;
    const referenced = await this.storage.isModelAssetReferenced(url);
    if (referenced) return { deleted: false, referenced: true };

    await fsp.rm(path.join(this.modelsDirectory, `${assetId}.glb`), { force: true });
    return { deleted: true, referenced: false };
  }
}

function sendModelError(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : "3D model operation failed";
  res.status(400).json({ message });
}

export function registerModelAssetRoutes(app: Express, service: ModelAssetService) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, service.tempRoot),
      filename: (_req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        callback(null, `${crypto.randomUUID()}${MODEL_EXTENSIONS.has(extension) ? extension : ".invalid"}`);
      },
    }),
    limits: { files: 1, fileSize: MAX_SOURCE_SIZE },
    fileFilter: (_req, file, callback) => {
      callback(null, MODEL_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()));
    },
  });

  app.get("/api/kicad/settings", (_req, res) => res.json(service.getStatus()));

  app.put("/api/kicad/settings", async (req, res) => {
    try {
      res.json(await service.updateSettings(req.body));
    } catch (error) {
      sendModelError(res, error);
    }
  });

  app.post("/api/kicad/models/reindex", async (_req, res) => {
    try {
      await service.reindex();
      res.json(service.getStatus());
    } catch (error) {
      sendModelError(res, error);
    }
  });

  app.get("/api/kicad/models", async (req, res) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q : "";
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
      res.json(await service.search(query, limit));
    } catch (error) {
      sendModelError(res, error);
    }
  });

  app.post("/api/models/import-local", async (req, res) => {
    try {
      const { modelId } = importBodySchema.parse(req.body);
      res.json(await service.importIndexedModel(modelId));
    } catch (error) {
      sendModelError(res, error);
    }
  });

  app.post("/api/models/upload", (req: Request, res: Response) => {
    upload.single("model")(req, res, async error => {
      if (error) return sendModelError(res, error);
      if (!req.file) return res.status(400).json({ message: "Choose a STEP, STP, WRL, or GLB file" });
      try {
        res.json(await service.importUpload(req.file));
      } catch (importError) {
        sendModelError(res, importError);
      }
    });
  });

  app.delete("/api/models/:assetId", async (req, res) => {
    try {
      res.json(await service.deleteAsset(req.params.assetId));
    } catch (error) {
      sendModelError(res, error);
    }
  });
}
