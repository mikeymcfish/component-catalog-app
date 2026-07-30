import fs from "node:fs";
import path from "node:path";
import type { Case, InsertCase } from "@shared/schema";
import type { IStorage } from "./storage";
import type { ModelAsset, ModelAssetService } from "./model-assets";

type CaseModelPart = "top" | "bottom";

interface DefaultCaseModelFiles {
  top: string;
  bottom: string;
}

interface DefaultCaseModels {
  top?: ModelAsset;
  bottom?: ModelAsset;
}

export type DefaultCaseModelCatalog = ReadonlyMap<string, DefaultCaseModels>;

// These filenames describe the compartment geometry inside each bundled GLB:
// 72 small bins, a 24-bin mixed layer, and a 24-bin uniform variant.
const DEFAULT_CASE_MODEL_FILES: Readonly<Record<string, DefaultCaseModelFiles>> = {
  "LAYOUT-12x6-BOTH": { top: "all-small.glb", bottom: "all-small.glb" },
  "LAYOUT-6x4-TOP": { top: "mixed.glb", bottom: "all-small.glb" },
  "LAYOUT-6x4-BOTH": { top: "variant.glb", bottom: "variant.glb" },
};

function isPathInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function loadDefaultCaseModelCatalog(
  service: ModelAssetService,
  directory = process.env.DEFAULT_CASE_MODELS_DIR || path.join(process.cwd(), "default-cases"),
): Promise<DefaultCaseModelCatalog> {
  let realDirectory: string;
  try {
    realDirectory = fs.realpathSync(path.resolve(directory));
    if (!fs.statSync(realDirectory).isDirectory()) return new Map();
  } catch {
    // Bundled case models are optional. Manual per-case uploads remain usable
    // when a source checkout or production package does not include them.
    return new Map();
  }

  const assetsByFilename = new Map<string, ModelAsset>();
  for (const filename of Array.from(new Set(
    Object.values(DEFAULT_CASE_MODEL_FILES).flatMap(files => [files.top, files.bottom]),
  ))) {
    try {
      const candidate = fs.realpathSync(path.join(realDirectory, filename));
      if (!isPathInside(candidate, realDirectory) || !fs.statSync(candidate).isFile()) {
        continue;
      }
      assetsByFilename.set(filename, await service.importBundledGlb(candidate));
    } catch (error) {
      console.warn(
        `Default case model ${filename} could not be published:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const catalog = new Map<string, DefaultCaseModels>();
  for (const [model, files] of Object.entries(DEFAULT_CASE_MODEL_FILES)) {
    const models: DefaultCaseModels = {
      top: assetsByFilename.get(files.top),
      bottom: assetsByFilename.get(files.bottom),
    };
    if (models.top || models.bottom) catalog.set(model, models);
  }
  return catalog;
}

export function isCompleteDefaultCaseModelCatalog(catalog: DefaultCaseModelCatalog) {
  return Object.keys(DEFAULT_CASE_MODEL_FILES).every(model => {
    const defaults = catalog.get(model);
    return Boolean(defaults?.top && defaults.bottom);
  });
}

function setModelPart(
  updates: Partial<InsertCase>,
  part: CaseModelPart,
  asset: ModelAsset,
) {
  if (part === "top") {
    updates.topModel3dUrl = asset.url;
    updates.topModel3dName = asset.name;
    updates.topModel3dSource = asset.source;
    return;
  }

  updates.bottomModel3dUrl = asset.url;
  updates.bottomModel3dName = asset.name;
  updates.bottomModel3dSource = asset.source;
}

export function getMissingDefaultCaseModelUpdates(
  case_: Case,
  catalog: DefaultCaseModelCatalog,
) {
  const defaults = catalog.get(case_.model);
  const updates: Partial<InsertCase> = {};
  if (!defaults) return updates;

  // Treat each URL/name/source trio as one association. If a URL already
  // exists, it is user or import data and must not be relabeled or replaced.
  if (!case_.topModel3dUrl && defaults.top) {
    setModelPart(updates, "top", defaults.top);
  }
  if (case_.hasBottom && !case_.bottomModel3dUrl && defaults.bottom) {
    setModelPart(updates, "bottom", defaults.bottom);
  }
  return updates;
}

export async function ensureDefaultCaseModels(
  storage: IStorage,
  case_: Case,
  catalog: DefaultCaseModelCatalog,
) {
  const updates = getMissingDefaultCaseModelUpdates(case_, catalog);
  if (Object.keys(updates).length === 0) return case_;
  return await storage.updateCase(case_.id, updates) ?? case_;
}

export async function seedMissingDefaultCaseModels(
  storage: IStorage,
  catalog: DefaultCaseModelCatalog,
) {
  if (catalog.size === 0) return;
  for (const case_ of await storage.getCases()) {
    await ensureDefaultCaseModels(storage, case_, catalog);
  }
}
