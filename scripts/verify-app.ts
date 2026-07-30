import express from "express";
import type { Server } from "http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UNORGANIZED_CASE_MODEL,
  UNSORTED_CASE_COLS,
  UNSORTED_CASE_MODEL,
  UNSORTED_CASE_NAME,
  UNSORTED_CASE_ROWS,
} from "../shared/case-layouts";
import {
  replaceCustomCaseLayer,
  resizeCustomCaseColumnBoundary,
  safeParseCustomCaseLayout,
} from "../shared/custom-case-layout";
import type {
  Case,
  CaseWithCompartments,
  Component,
  ComponentBook,
  ComponentBookItem,
  ComponentBookSearchResult,
  ComponentBookWithItems,
  Adapter,
  Tool,
} from "../shared/schema";
import type { CaseModelCalibration } from "../shared/model-calibration";
import {
  componentModelRotationSchema,
  type ComponentModelRotation,
} from "../shared/component-model-rotation";

interface ModelAsset {
  assetId: string;
  url: string;
  name: string;
  source: "kicad" | "upload";
}

function createComponentModelRotation(
  assetId: string,
  turns: Partial<Pick<ComponentModelRotation, "xQuarterTurns" | "yQuarterTurns" | "zQuarterTurns">> = {},
): ComponentModelRotation {
  return {
    version: 1,
    assetId,
    xQuarterTurns: turns.xQuarterTurns ?? 1,
    yQuarterTurns: turns.yQuarterTurns ?? 0,
    zQuarterTurns: turns.zQuarterTurns ?? 0,
  };
}

function createMinimalGlb(label?: string) {
  const document = { asset: { version: "2.0" }, scene: 0, scenes: [{}], ...(label ? { extras: { label } } : {}) };
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const output = Buffer.alloc(20 + paddedLength, 0x20);
  output.write("glTF", 0, "ascii");
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  return output;
}

function createCaseModelCalibration(assetId: string): CaseModelCalibration {
  return {
    version: 1,
    assetId,
    metersPerModelUnit: 1,
    origin: { x: 0, y: 0, z: 0 },
    columnAxis: { x: 0.019, y: 0, z: 0 },
    rowAxis: { x: 0, y: -0.019, z: 0 },
    outwardNormal: { x: 0, y: 0, z: 1 },
    rimOffset: 0.002,
    anchorOverrides: {
      A1: { x: 0.001, y: -0.001, z: -0.017 },
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRejects(promise: Promise<unknown>, message: string) {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const validRotation = createComponentModelRotation("a".repeat(64));
  assert(componentModelRotationSchema.safeParse(validRotation).success, "Quarter-turn rotation should validate");
  assert(
    !componentModelRotationSchema.safeParse({ ...validRotation, xQuarterTurns: 4 }).success,
    "Quarter turns outside 0-3 must be rejected",
  );
  assert(
    !componentModelRotationSchema.safeParse({ ...validRotation, yQuarterTurns: 1.5 }).success,
    "Fractional quarter turns must be rejected",
  );
  assert(
    !componentModelRotationSchema.safeParse({ ...validRotation, unexpected: true }).success,
    "Rotation payloads must reject unknown fields",
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "component-catalog-app-test-"));
  const uploadsDir = path.join(tempDir, "uploads");
  const modelTempDir = path.join(tempDir, "model-temp");
  const kicadSettingsFile = path.join(tempDir, "kicad-settings.json");
  const modelLibraryDir = path.join(tempDir, "model-library");
  const fakeProgramFiles = path.join(tempDir, "program-files");
  const defaultCasesDir = path.join(process.cwd(), "default-cases");
  for (const filename of ["all-small.glb", "mixed.glb", "variant.glb"]) {
    assert(fs.existsSync(path.join(defaultCasesDir, filename)), `Expected bundled default case model ${filename}`);
  }
  fs.mkdirSync(modelLibraryDir, { recursive: true });
  fs.mkdirSync(fakeProgramFiles, { recursive: true });
  fs.writeFileSync(path.join(modelLibraryDir, "Verification_Package.glb"), createMinimalGlb());
  fs.writeFileSync(path.join(modelLibraryDir, "Verification_Sensor.step"), "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
  process.env.STORAGE_FILE = path.join(tempDir, "storage.json");
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.MODEL_TEMP_DIR = modelTempDir;
  process.env.KICAD_SETTINGS_FILE = kicadSettingsFile;
  process.env.DEFAULT_CASE_MODELS_DIR = defaultCasesDir;
  process.env.ProgramFiles = fakeProgramFiles;
  process.env["ProgramFiles(x86)"] = fakeProgramFiles;
  delete process.env.KICAD_CLI_PATH;
  delete process.env.HF_TOKEN;
  delete process.env.HUGGINGFACE_API_KEY;
  delete process.env.HUGGINGFACEHUB_API_TOKEN;
  const [{ registerRoutes }, { ModelAssetService }, { MemStorage }] = await Promise.all([
    import("../server/routes"),
    import("../server/model-assets"),
    import("../server/storage"),
  ]);

  const fakeInstallDir = path.join(tempDir, "fake-kicad");
  const fakeCliPath = path.join(fakeInstallDir, "bin", process.platform === "win32" ? "kicad-cli.exe" : "kicad-cli");
  fs.mkdirSync(path.dirname(fakeCliPath), { recursive: true });
  fs.writeFileSync(fakeCliPath, "not a real executable");

  let conversionCount = 0;
  const directService = new ModelAssetService({
    uploadsRoot: path.join(tempDir, "direct-uploads"),
    storage: new MemStorage(false),
    settingsFile: kicadSettingsFile,
    tempRoot: path.join(tempDir, "direct-temp"),
    conversionRunner: async ({ outputPath }) => {
      conversionCount += 1;
      fs.writeFileSync(outputPath, createMinimalGlb());
    },
  });
  await directService.updateSettings({
    kicadDirectory: fakeInstallDir,
    modelDirectories: [modelLibraryDir],
  });
  const directIndex = await directService.reindex();
  assert(directIndex.count === 2, "KiCad index should include supported models from the configured directory");
  const directSearch = await directService.search("verification sensor", 30);
  assert(directSearch.results.length === 1, "KiCad search should match model names case-insensitively");
  assert(!JSON.stringify(directSearch).includes(modelLibraryDir), "KiCad search must not expose absolute filesystem paths");
  const convertedAsset = await directService.importIndexedModel(directSearch.results[0].id);
  assert(convertedAsset.url.endsWith(".glb"), "STEP conversion should publish a GLB asset");
  assert(fs.existsSync(path.join(tempDir, "direct-uploads", convertedAsset.url.replace("/uploads/", ""))), "Converted GLB should exist");
  await directService.importIndexedModel(directSearch.results[0].id);
  assert(conversionCount === 1, "Repeated imports should reuse the hash/version conversion cache");
  assert(
    fs.readdirSync(path.join(tempDir, "direct-uploads", "models")).every(name => name.endsWith(".glb")),
    "Permanent model storage should retain only GLB files",
  );
  await assertRejects(
    directService.importIndexedModel("0".repeat(64)),
    "Unknown opaque model IDs should be rejected",
  );

  const failureService = new ModelAssetService({
    uploadsRoot: path.join(tempDir, "failure-uploads"),
    storage: new MemStorage(false),
    settingsFile: path.join(tempDir, "failure-settings.json"),
    tempRoot: path.join(tempDir, "failure-temp"),
    conversionRunner: async () => {
      throw new Error("simulated converter failure");
    },
  });
  await failureService.updateSettings({
    kicadDirectory: fakeInstallDir,
    modelDirectories: [modelLibraryDir],
  });
  await failureService.reindex();
  const failureResult = await failureService.search("verification sensor", 10);
  await assertRejects(
    failureService.importIndexedModel(failureResult.results[0].id),
    "Converter failures should reject the import",
  );
  assert(fs.readdirSync(failureService.modelsDirectory).length === 0, "Failed conversion must not publish a model asset");
  assert(fs.readdirSync(failureService.tempRoot).length === 0, "Failed conversion must clean temporary source and board files");

  const app = express();
  app.use(express.json());
  app.get("/fixtures/example-datasheet.pdf", (_req, res) => {
    res.type("application/pdf").send(Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n"));
  });
  app.get("/fixtures/example-photo.png", (_req, res) => {
    res
      .type("image/png")
      .send(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
  });
  app.get("/fixtures/fake-photo.jpg", (_req, res) => {
    res.type("image/jpeg").send("<!doctype html><html><body>Access denied</body></html>");
  });
  app.get("/fixtures/photo-page", (_req, res) => {
    res.type("html").send(`
      <!doctype html>
      <html>
        <head><meta property="og:image" content="/fixtures/example-photo.png"></head>
        <body><img src="/fixtures/example-photo.png" alt="Example photo"></body>
      </html>
    `);
  });

  const server = await registerRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  assert(address && typeof address !== "string", "Test server did not bind to a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
    }

    return text ? JSON.parse(text) as T : undefined as T;
  }

  const health = await request<{ app: string; status: string; port: number | null }>(
    "GET",
    "/api/health",
  );
  assert(health.app === "component-catalog", "Health endpoint should identify this application");
  assert(health.status === "ok", "Health endpoint should report a ready catalog");
  assert(health.port === address.port, "Health endpoint should report the selected TCP port");

  async function uploadModel(buffer: Buffer, filename: string) {
    const body = new FormData();
    body.append("model", new Blob([buffer], { type: "application/octet-stream" }), filename);
    const response = await fetch(`${baseUrl}/api/models/upload`, { method: "POST", body });
    const text = await response.text();
    return { response, text, json: response.ok ? JSON.parse(text) as ModelAsset : null };
  }

  async function uploadCaseImage(
    caseId: number,
    variant: "closed" | "open",
    buffer: Buffer,
    filename: string,
    contentType = "image/png",
  ) {
    const body = new FormData();
    body.append("image", new Blob([buffer], { type: contentType }), filename);
    const response = await fetch(`${baseUrl}/api/cases/${caseId}/images/${variant}`, {
      method: "POST",
      body,
    });
    const text = await response.text();
    return { response, text, json: response.ok ? JSON.parse(text) as Case : null };
  }

  async function uploadCaseModel(
    caseId: number,
    part: "top" | "bottom",
    buffer: Buffer,
    filename: string,
  ) {
    const body = new FormData();
    body.append("model", new Blob([buffer], { type: "model/gltf-binary" }), filename);
    const response = await fetch(`${baseUrl}/api/cases/${caseId}/models/${part}`, {
      method: "POST",
      body,
    });
    const text = await response.text();
    return { response, text, json: response.ok ? JSON.parse(text) as Case : null };
  }

  try {
    const initialKicadStatus = await request<{
      cliAvailable: boolean;
      modelLibraryAvailable: boolean;
      index: { count: number };
      saved: { kicadDirectory: string | null; modelDirectories: string[] };
    }>("GET", "/api/kicad/settings");
    assert(initialKicadStatus.saved.kicadDirectory === fakeInstallDir, "KiCad settings should persist to the configured settings file");
    assert(initialKicadStatus.modelLibraryAvailable, "Configured KiCad model directory should be available");

    const reindexedStatus = await request<{ index: { count: number } }>("POST", "/api/kicad/models/reindex");
    assert(reindexedStatus.index.count === 2, "Reindex API should report every supported local model");
    const indexedModels = await request<{ results: Array<{ id: string; relativePath: string; name: string }> }>(
      "GET",
      "/api/kicad/models?q=VERIFICATION&limit=30",
    );
    assert(indexedModels.results.length === 2, "Model search API should be case-insensitive");
    assert(indexedModels.results.every(model => /^[a-f0-9]{64}$/.test(model.id)), "Model search should return opaque IDs");
    assert(!JSON.stringify(indexedModels).includes(modelLibraryDir), "Model search API must not reveal absolute paths");

    const tamperedModelResponse = await fetch(`${baseUrl}/api/models/import-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "../../outside.step" }),
    });
    assert(!tamperedModelResponse.ok, "Local model import should reject paths and accept only opaque IDs");

    const uploadedModel = await uploadModel(createMinimalGlb(), "Verification Upload.glb");
    assert(uploadedModel.response.ok && uploadedModel.json, `Valid GLB upload should succeed: ${uploadedModel.text}`);
    const uploadedModelAsset = uploadedModel.json;
    assert(uploadedModelAsset.source === "upload", "Uploaded model should be marked as an upload");
    assert(/^\/uploads\/models\/[a-f0-9]{64}\.glb$/.test(uploadedModelAsset.url), "Uploaded model should receive an opaque GLB URL");
    assert(!fs.existsSync(path.join(uploadsDir, "models", "Verification Upload.glb")), "Original upload filename should not be retained");

    const servedModel = await fetch(`${baseUrl}${uploadedModelAsset.url}`);
    assert(servedModel.ok, "Published GLB should be served to the viewer");
    assert(servedModel.headers.get("content-type")?.startsWith("model/gltf-binary"), "GLB should use model/gltf-binary MIME type");
    assert(servedModel.headers.get("x-content-type-options") === "nosniff", "GLB responses should disable MIME sniffing");

    const duplicateModel = await uploadModel(createMinimalGlb(), "Same Geometry.glb");
    assert(duplicateModel.response.ok && duplicateModel.json?.assetId === uploadedModelAsset.assetId, "Identical GLB uploads should reuse the hash cache");

    const concurrentGlb = createMinimalGlb("concurrent-upload");
    const [concurrentModelA, concurrentModelB] = await Promise.all([
      uploadModel(concurrentGlb, "Concurrent A.glb"),
      uploadModel(concurrentGlb, "Concurrent B.glb"),
    ]);
    assert(
      concurrentModelA.response.ok && concurrentModelB.response.ok && concurrentModelA.json?.assetId === concurrentModelB.json?.assetId,
      "Simultaneous identical uploads should share one atomic asset build",
    );

    const invalidGlb = Buffer.from(createMinimalGlb());
    invalidGlb.writeUInt32LE(invalidGlb.length + 100, 8);
    const invalidGlbUpload = await uploadModel(invalidGlb, "broken.glb");
    assert(!invalidGlbUpload.response.ok, "GLB uploads with invalid declared length should be rejected");
    const truncatedChunkGlb = Buffer.concat([createMinimalGlb(), Buffer.alloc(4)]);
    truncatedChunkGlb.writeUInt32LE(truncatedChunkGlb.length, 8);
    const truncatedChunkUpload = await uploadModel(truncatedChunkGlb, "truncated-chunk.glb");
    assert(!truncatedChunkUpload.response.ok, "GLB uploads with truncated trailing chunks should be rejected");
    const fakeStepUpload = await uploadModel(Buffer.from("not actually step"), "fake.step");
    assert(!fakeStepUpload.response.ok, "STEP uploads with invalid signatures should be rejected");
    assert(fs.readdirSync(modelTempDir).length === 0, "Uploaded originals should be removed from temporary storage");

    const initialCases = await request<Case[]>("GET", "/api/cases");
    assert(initialCases.length > 0, "Expected the default case to exist");
    const unsortedCase = initialCases.find(case_ => case_.model === UNSORTED_CASE_MODEL);
    assert(unsortedCase, "Expected the unsorted items case to exist");
    assert(unsortedCase.name === UNSORTED_CASE_NAME, "Unsorted case should use the expected name");

    const unsortedCaseDetails = await request<CaseWithCompartments>("GET", `/api/cases/${unsortedCase.id}`);
    assert(unsortedCaseDetails.compartments.length === 100, "Unsorted case should create 100 holding slots");

    const initialTools = await request<Tool[]>("GET", "/api/tools");
    assert(initialTools.length === 0, "A new catalog should start with an empty tools section");

    const oscilloscope = await request<Tool>("POST", "/api/tools", {
      name: "Verification Oscilloscope",
      category: "Oscilloscope",
      manufacturer: "Rigol",
      modelNumber: "DS1054Z",
      productUrl: "https://example.com/tools/ds1054z",
      imageUrl: "https://example.com/images/ds1054z.jpg",
      quantity: 1,
      location: "Electronics bench",
      capabilities: "4 channels, 50 MHz bandwidth, protocol decoding",
      notes: "Use the 10x probes for power-rail checks",
    });
    assert(oscilloscope.id > 0, "Creating a tool should assign an ID");
    assert(oscilloscope.manufacturer === "Rigol", "Tool manufacturer should be saved");
    assert(oscilloscope.modelNumber === "DS1054Z", "Tool model number should be saved");
    assert(oscilloscope.productUrl?.endsWith("/ds1054z"), "Tool product URL should be saved");
    assert(oscilloscope.imageUrl?.endsWith("/ds1054z.jpg"), "Tool image URL should be saved");
    assert(oscilloscope.quantity === 1, "Tool quantity should be saved");
    assert(oscilloscope.location === "Electronics bench", "Tool location should be saved");
    assert(oscilloscope.capabilities?.includes("50 MHz"), "Tool capabilities should be saved");
    assert(oscilloscope.notes?.includes("10x probes"), "Tool notes should be saved");

    const minimalTool = await request<Tool>("POST", "/api/tools", {
      name: "Verification Logic Probe",
      category: "Probe",
    });
    assert(minimalTool.quantity === 1, "Tool quantity should default to one");
    assert(minimalTool.manufacturer === null, "Omitted tool manufacturer should normalize to null");
    assert(minimalTool.modelNumber === null, "Omitted tool model number should normalize to null");
    assert(minimalTool.productUrl === null, "Omitted tool product URL should normalize to null");
    assert(minimalTool.imageUrl === null, "Omitted tool image URL should normalize to null");
    assert(minimalTool.location === null, "Omitted tool location should normalize to null");
    assert(minimalTool.capabilities === null, "Omitted tool capabilities should normalize to null");
    assert(minimalTool.notes === null, "Omitted tool notes should normalize to null");

    const missingCategoryResponse = await fetch(`${baseUrl}/api/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Incomplete Tool" }),
    });
    assert(missingCategoryResponse.status === 400, "Tool creation should reject a missing category");

    const zeroQuantityResponse = await fetch(`${baseUrl}/api/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Impossible Tool", category: "Probe", quantity: 0 }),
    });
    assert(zeroQuantityResponse.status === 400, "Tool creation should reject a quantity below one");

    const updatedOscilloscope = await request<Tool>("PATCH", `/api/tools/${oscilloscope.id}`, {
      quantity: 2,
      location: "Debug cart",
      capabilities: "4 channels, 50 MHz bandwidth, protocol decoding, FFT",
    });
    assert(updatedOscilloscope.quantity === 2, "Tool quantity should be editable");
    assert(updatedOscilloscope.location === "Debug cart", "Tool location should be editable");
    assert(updatedOscilloscope.capabilities?.endsWith("FFT"), "Tool capabilities should be editable");
    assert(updatedOscilloscope.manufacturer === "Rigol", "Partial tool edits should preserve other fields");

    const listedTools = await request<Tool[]>("GET", "/api/tools");
    assert(listedTools.some(tool => tool.id === oscilloscope.id), "The tools list should include created tools");
    assert(listedTools.some(tool => tool.id === minimalTool.id), "The tools list should include minimally specified tools");

    await request<{ message: string }>("DELETE", `/api/tools/${minimalTool.id}`);
    const deletedToolUpdate = await fetch(`${baseUrl}/api/tools/${minimalTool.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 3 }),
    });
    assert(deletedToolUpdate.status === 404, "Updating a deleted tool should return not found");

    const initialAdapters = await request<Adapter[]>("GET", "/api/adapters");
    assert(initialAdapters.length === 0, "A new catalog should start with an empty adapters section");

    const debugAdapter = await request<Adapter>("POST", "/api/adapters", {
      name: "Verification SWD Adapter",
      category: "Programming Adapter",
      manufacturer: "Verification Labs",
      modelNumber: "SWD-10-6",
      productUrl: "https://example.com/adapters/swd-10-6",
      imageUrl: "https://example.com/images/swd-10-6.jpg",
      endpointA: "10-pin 1.27 mm Cortex Debug header",
      endpointAType: "debug-header",
      endpointB: "6-pin 2.54 mm SWD header",
      endpointBType: "pin-header",
      quantity: 2,
      location: "Debug cart",
      compatibility: "10-pin 1.27 mm Cortex Debug to 6-pin 2.54 mm SWD; 3.3 V targets",
      notes: "Pin 1 is marked by the red stripe",
    });
    assert(debugAdapter.id > 0, "Creating an adapter should assign an ID");
    assert(debugAdapter.manufacturer === "Verification Labs", "Adapter manufacturer should be saved");
    assert(debugAdapter.modelNumber === "SWD-10-6", "Adapter model number should be saved");
    assert(debugAdapter.productUrl?.endsWith("/swd-10-6"), "Adapter product URL should be saved");
    assert(debugAdapter.imageUrl?.endsWith("/swd-10-6.jpg"), "Adapter image URL should be saved");
    assert(debugAdapter.endpointA === "10-pin 1.27 mm Cortex Debug header", "Adapter endpoint A should be saved");
    assert(debugAdapter.endpointAType === "debug-header", "Adapter endpoint A icon type should be saved");
    assert(debugAdapter.endpointB === "6-pin 2.54 mm SWD header", "Adapter endpoint B should be saved");
    assert(debugAdapter.endpointBType === "pin-header", "Adapter endpoint B icon type should be saved");
    assert(debugAdapter.quantity === 2, "Adapter quantity should be saved");
    assert(debugAdapter.location === "Debug cart", "Adapter location should be saved");
    assert(debugAdapter.compatibility?.includes("3.3 V"), "Adapter compatibility should be saved");
    assert(debugAdapter.notes?.includes("red stripe"), "Adapter notes should be saved");

    const minimalAdapter = await request<Adapter>("POST", "/api/adapters", {
      name: "Verification USB Adapter",
      category: "USB Adapter",
    });
    assert(minimalAdapter.quantity === 1, "Adapter quantity should default to one");
    assert(minimalAdapter.manufacturer === null, "Omitted adapter manufacturer should normalize to null");
    assert(minimalAdapter.modelNumber === null, "Omitted adapter model number should normalize to null");
    assert(minimalAdapter.productUrl === null, "Omitted adapter product URL should normalize to null");
    assert(minimalAdapter.imageUrl === null, "Omitted adapter image URL should normalize to null");
    assert(minimalAdapter.endpointA === null, "Omitted adapter endpoint A should normalize to null");
    assert(minimalAdapter.endpointAType === null, "Omitted adapter endpoint A type should normalize to null");
    assert(minimalAdapter.endpointB === null, "Omitted adapter endpoint B should normalize to null");
    assert(minimalAdapter.endpointBType === null, "Omitted adapter endpoint B type should normalize to null");
    assert(minimalAdapter.location === null, "Omitted adapter location should normalize to null");
    assert(minimalAdapter.compatibility === null, "Omitted adapter compatibility should normalize to null");
    assert(minimalAdapter.notes === null, "Omitted adapter notes should normalize to null");

    const editedMinimalAdapter = await request<Adapter>("PATCH", `/api/adapters/${minimalAdapter.id}`, {
      location: "Legacy adapter drawer",
    });
    assert(editedMinimalAdapter.location === "Legacy adapter drawer", "Adapters without endpoints should remain editable");
    assert(editedMinimalAdapter.endpointA === null && editedMinimalAdapter.endpointB === null, "Unrelated edits should preserve blank endpoints");

    const halfDefinedAdapter = await fetch(`${baseUrl}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Half-defined Adapter",
        category: "Cable",
        endpointA: "USB-C plug",
      }),
    });
    assert(halfDefinedAdapter.status === 400, "Adapter creation should reject a single unpaired endpoint");

    const invalidEndpointType = await fetch(`${baseUrl}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mistyped Endpoint Adapter",
        category: "Cable",
        endpointA: "USB-C plug",
        endpointAType: "usbc-connector",
        endpointB: "USB-A plug",
        endpointBType: "usb",
      }),
    });
    assert(invalidEndpointType.status === 400, "Adapter creation should reject unknown endpoint icon types");

    const missingAdapterCategory = await fetch(`${baseUrl}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Incomplete Adapter" }),
    });
    assert(missingAdapterCategory.status === 400, "Adapter creation should reject a missing category");

    const zeroAdapterQuantity = await fetch(`${baseUrl}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Impossible Adapter", category: "Cable", quantity: 0 }),
    });
    assert(zeroAdapterQuantity.status === 400, "Adapter creation should reject a quantity below one");

    const unsafeAdapterUrl = await fetch(`${baseUrl}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unsafe Adapter",
        category: "Cable",
        productUrl: "javascript:alert(1)",
      }),
    });
    assert(unsafeAdapterUrl.status === 400, "Adapter creation should reject unsafe URL schemes");

    const malformedAdapterUrl = await fetch(`${baseUrl}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Malformed URL Adapter",
        category: "Cable",
        imageUrl: "https://",
      }),
    });
    assert(malformedAdapterUrl.status === 400, "Adapter creation should reject malformed HTTP(S) URLs");

    const updatedAdapter = await request<Adapter>("PATCH", `/api/adapters/${debugAdapter.id}`, {
      quantity: 3,
      location: "Adapter drawer",
      endpointAType: " debug-header ",
      compatibility: "10-pin 1.27 mm Cortex Debug to 6-pin 2.54 mm SWD; 1.8-5 V targets",
    });
    assert(updatedAdapter.quantity === 3, "Adapter quantity should be editable");
    assert(updatedAdapter.location === "Adapter drawer", "Adapter location should be editable");
    assert(updatedAdapter.compatibility?.includes("1.8-5 V"), "Adapter compatibility should be editable");
    assert(updatedAdapter.endpointAType === "debug-header", "Adapter endpoint icon types should be trimmed and normalized");
    assert(updatedAdapter.manufacturer === "Verification Labs", "Partial adapter edits should preserve other fields");

    const halfEndpointUpdate = await fetch(`${baseUrl}/api/adapters/${debugAdapter.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpointA: null }),
    });
    assert(halfEndpointUpdate.status === 400, "Adapter updates should reject leaving only one endpoint defined");

    const adapterSearch = await request<Adapter[]>(
      "GET",
      "/api/adapters/search?q=6-pin%202.54%20mm%20SWD",
    );
    assert(
      adapterSearch.some(adapter => adapter.id === debugAdapter.id),
      "Adapter search should match an explicit endpoint label",
    );

    await request<{ message: string }>("DELETE", `/api/adapters/${minimalAdapter.id}`);
    const deletedAdapterUpdate = await fetch(`${baseUrl}/api/adapters/${minimalAdapter.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 2 }),
    });
    assert(deletedAdapterUpdate.status === 404, "Updating a deleted adapter should return not found");

    const initialComponentBooks = await request<ComponentBookWithItems[]>("GET", "/api/component-books");
    assert(initialComponentBooks.length === 0, "A new catalog should start with no component books");

    const componentBook = await request<ComponentBook>("POST", "/api/component-books", {
      name: "0603 Verification Component Book",
      manufacturer: "Verification Parts",
      packageSize: "0603",
      productUrl: "https://example.com/books/0603",
      imageUrl: "https://example.com/images/0603-book.jpg",
      description: "A searchable SMD sample book",
      notes: "Values are labeled on each strip",
    });
    assert(componentBook.packageSize === "0603", "Component books should preserve package size");
    const resistorBookItem = await request<ComponentBookItem>(
      "POST",
      `/api/component-books/${componentBook.id}/items`,
      {
        name: "10 kΩ resistor",
        category: "Resistor",
        value: "10 kΩ",
        packageSize: "0603",
        quantity: 25,
        notes: "1% tolerance",
      },
    );
    const capacitorBookItem = await request<ComponentBookItem>(
      "POST",
      `/api/component-books/${componentBook.id}/items`,
      {
        name: "100 nF capacitor",
        category: "Capacitor",
        partNumber: "C0603-100N",
        value: "100 nF",
        packageSize: "0603",
        quantity: 20,
      },
    );
    assert(resistorBookItem.bookId === componentBook.id, "Book items should be linked to their book");
    assert(capacitorBookItem.packageSize === "0603", "Book items should preserve package size");

    const populatedBook = await request<ComponentBookWithItems>(
      "GET",
      `/api/component-books/${componentBook.id}`,
    );
    assert(populatedBook.items.length === 2, "A component book response should include its line items");
    const bookSearchResults = await request<ComponentBookSearchResult[]>(
      "GET",
      "/api/component-book-items/search?q=10%20k%CE%A9",
    );
    assert(
      bookSearchResults.some(result =>
        result.id === resistorBookItem.id && result.book.id === componentBook.id
      ),
      "Book item search should return the matching item with book metadata",
    );
    const packageSearchResults = await request<ComponentBookSearchResult[]>(
      "GET",
      "/api/component-book-items/search?q=0603",
    );
    assert(packageSearchResults.length === 2, "Book item search should match package size");

    const updatedBookItem = await request<ComponentBookItem>(
      "PATCH",
      `/api/component-book-items/${resistorBookItem.id}`,
      { quantity: 30 },
    );
    assert(updatedBookItem.quantity === 30, "Book item quantity should be editable");

    const missingBookItemResponse = await fetch(`${baseUrl}/api/component-books/999999/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Orphan component" }),
    });
    assert(missingBookItemResponse.status === 404, "Items cannot be added to a missing component book");

    const createdCase = await request<Case>("POST", "/api/cases", {
      name: "Verification Case",
      model: "LAYOUT-6x4-TOP",
      description: "Created by the verification script",
    });
    assert(createdCase.rows === 4, "Created case should use 4 top rows");
    assert(createdCase.cols === 6, "Created case should use 6 top columns");
    assert(createdCase.hasBottom === true, "Created mixed-layout case should have a bottom layer");
    assert(createdCase.topModel3dUrl?.match(/^\/uploads\/models\/[a-f0-9]{64}\.glb$/), "Mixed preset should receive its bundled top GLB");
    assert(createdCase.bottomModel3dUrl?.match(/^\/uploads\/models\/[a-f0-9]{64}\.glb$/), "Mixed preset should receive its bundled bottom GLB");
    assert(createdCase.topModel3dName === "mixed", "Mixed preset should use mixed.glb for its top layer");
    assert(createdCase.bottomModel3dName === "all-small", "Mixed preset should use all-small.glb for its bottom layer");
    const defaultTopModelUrl = createdCase.topModel3dUrl;
    const defaultBottomModelUrl = createdCase.bottomModel3dUrl;
    assert(defaultTopModelUrl, "Mixed preset top GLB URL should be present");
    assert(defaultBottomModelUrl, "Mixed preset bottom GLB URL should be present");
    const defaultTopModelId = defaultTopModelUrl.match(/([a-f0-9]{64})\.glb$/)?.[1];
    assert(defaultTopModelId, "Bundled top GLB should use a hash asset ID");
    assert(fs.existsSync(path.join(uploadsDir, "models", `${defaultTopModelId}.glb`)), "Bundled top GLB should be copied into managed uploads");
    const caseWithDefaultModels = await request<CaseWithCompartments>("GET", `/api/cases/${createdCase.id}`);
    assert(caseWithDefaultModels.topModel3dUrl === defaultTopModelUrl, "Case reload should retain the default top GLB association");
    assert(caseWithDefaultModels.bottomModel3dUrl === defaultBottomModelUrl, "Case reload should retain the default bottom GLB association");

    const closedPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    const openPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );

    const closedImageUpload = await uploadCaseImage(createdCase.id, "closed", closedPng, "closed-case.png");
    assert(closedImageUpload.response.ok && closedImageUpload.json, `Closed case image upload should succeed: ${closedImageUpload.text}`);
    assert(
      /^\/uploads\/case-images\/[a-f0-9]{64}\.png$/.test(closedImageUpload.json.closedImageUrl || ""),
      "Closed case images should receive a hash-based local URL",
    );
    const closedImageUrl = closedImageUpload.json.closedImageUrl!;
    const closedImagePath = path.join(uploadsDir, closedImageUrl.replace("/uploads/", ""));
    assert(fs.existsSync(closedImagePath), "Closed case image should be written to permanent uploads");

    const servedCaseImage = await fetch(`${baseUrl}${closedImageUrl}`);
    assert(servedCaseImage.ok, "Uploaded case image should be served");
    assert(servedCaseImage.headers.get("content-type")?.startsWith("image/png"), "Case PNG should use an image MIME type");
    assert(servedCaseImage.headers.get("x-content-type-options") === "nosniff", "Case image responses should disable MIME sniffing");

    const openImageUpload = await uploadCaseImage(createdCase.id, "open", openPng, "open-case.png");
    assert(openImageUpload.response.ok && openImageUpload.json?.openImageUrl, `Open case image upload should succeed: ${openImageUpload.text}`);
    const openImageUrl = openImageUpload.json.openImageUrl;
    const openImagePath = path.join(uploadsDir, openImageUrl.replace("/uploads/", ""));
    assert(fs.existsSync(openImagePath), "Open case image should be written to permanent uploads");

    const fakeImageUpload = await uploadCaseImage(
      createdCase.id,
      "open",
      Buffer.from("not an image", "utf8"),
      "fake.png",
    );
    assert(!fakeImageUpload.response.ok, "Case image uploads should reject fake image bytes");

    const svgImageUpload = await uploadCaseImage(
      createdCase.id,
      "open",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8"),
      "case.svg",
      "image/svg+xml",
    );
    assert(!svgImageUpload.response.ok, "Case image uploads should reject SVG files");

    const arbitraryCaseImagePatch = await fetch(`${baseUrl}/api/cases/${createdCase.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closedImageUrl: "https://example.com/untrusted.png" }),
    });
    assert(!arbitraryCaseImagePatch.ok, "Case image fields should reject URLs outside managed uploads");

    const caseWithoutOpenImage = await request<Case>("DELETE", `/api/cases/${createdCase.id}/images/open`);
    assert(caseWithoutOpenImage.openImageUrl === null, "Deleting an open image should clear the case field");
    assert(!fs.existsSync(openImagePath), "Unreferenced removed case images should be deleted from uploads");

    const topCaseGlb = createMinimalGlb("case-top");
    const topCaseModelUpload = await uploadCaseModel(
      createdCase.id,
      "top",
      topCaseGlb,
      "case-top.glb",
    );
    assert(topCaseModelUpload.response.ok && topCaseModelUpload.json?.topModel3dUrl, `Top case GLB upload should succeed: ${topCaseModelUpload.text}`);
    assert(topCaseModelUpload.json.bottomModel3dUrl === defaultBottomModelUrl, "Replacing the top GLB should preserve the bundled bottom GLB");
    const originalTopCaseModelUrl = topCaseModelUpload.json.topModel3dUrl;
    const originalTopCaseModelId = originalTopCaseModelUrl.match(/([a-f0-9]{64})\.glb$/)?.[1];
    assert(originalTopCaseModelId, "Top case GLB should use a hash asset ID");
    const originalTopCaseModelPath = path.join(uploadsDir, "models", `${originalTopCaseModelId}.glb`);
    assert(fs.existsSync(originalTopCaseModelPath), "Top case GLB should be published");

    const topCalibration = createCaseModelCalibration(originalTopCaseModelId);
    const mismatchedCalibrationResponse = await fetch(
      `${baseUrl}/api/cases/${createdCase.id}/models/top/calibration`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...topCalibration, assetId: "0".repeat(64) }),
      },
    );
    assert(mismatchedCalibrationResponse.status === 409, "Calibration must be keyed to the active model hash");

    const parallelCalibrationResponse = await fetch(
      `${baseUrl}/api/cases/${createdCase.id}/models/top/calibration`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...topCalibration, rowAxis: { x: 0.038, y: 0, z: 0 } }),
      },
    );
    assert(parallelCalibrationResponse.status === 400, "Parallel calibration axes must be rejected");

    const coplanarNormalResponse = await fetch(
      `${baseUrl}/api/cases/${createdCase.id}/models/top/calibration`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...topCalibration, outwardNormal: { x: 1, y: 0, z: 0 } }),
      },
    );
    assert(coplanarNormalResponse.status === 400, "Outward normal must not lie in the calibration grid plane");

    const calibratedTopCase = await request<Case>(
      "PUT",
      `/api/cases/${createdCase.id}/models/top/calibration`,
      topCalibration,
    );
    assert(calibratedTopCase.topModel3dCalibration?.assetId === originalTopCaseModelId, "Top calibration should be saved");
    assert(calibratedTopCase.bottomModel3dCalibration === null, "Top calibration should not alter the bottom half");

    const calibrationPatchBypassResponse = await fetch(`${baseUrl}/api/cases/${createdCase.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topModel3dCalibration: topCalibration }),
    });
    assert(!calibrationPatchBypassResponse.ok, "Generic case updates must not bypass the calibrated-model endpoint");

    const sameTopCaseModelUpload = await uploadCaseModel(
      createdCase.id,
      "top",
      topCaseGlb,
      "same-case-top.glb",
    );
    assert(sameTopCaseModelUpload.response.ok && sameTopCaseModelUpload.json, "Reuploading the same top GLB should succeed");
    assert(sameTopCaseModelUpload.json.topModel3dUrl === originalTopCaseModelUrl, "Identical case GLBs should reuse the same asset hash");
    assert(
      sameTopCaseModelUpload.json.topModel3dCalibration?.assetId === originalTopCaseModelId,
      "Reuploading identical GLB bytes should preserve calibration",
    );

    const bottomCaseModelUpload = await uploadCaseModel(
      createdCase.id,
      "bottom",
      createMinimalGlb("case-bottom"),
      "case-bottom.glb",
    );
    assert(bottomCaseModelUpload.response.ok && bottomCaseModelUpload.json?.bottomModel3dUrl, `Bottom case GLB upload should succeed: ${bottomCaseModelUpload.text}`);
    assert(bottomCaseModelUpload.json.topModel3dUrl === originalTopCaseModelUrl, "Adding a bottom GLB should preserve the top GLB");
    const bottomCaseModelUrl = bottomCaseModelUpload.json.bottomModel3dUrl;
    const bottomCaseModelId = bottomCaseModelUrl.match(/([a-f0-9]{64})\.glb$/)?.[1];
    assert(bottomCaseModelId, "Bottom case GLB should use a hash asset ID");
    const bottomCaseModelPath = path.join(uploadsDir, "models", `${bottomCaseModelId}.glb`);
    assert(fs.existsSync(bottomCaseModelPath), "Bottom case GLB should be published");

    const bottomCalibration = createCaseModelCalibration(bottomCaseModelId);
    const calibratedBottomCase = await request<Case>(
      "PUT",
      `/api/cases/${createdCase.id}/models/bottom/calibration`,
      bottomCalibration,
    );
    assert(calibratedBottomCase.bottomModel3dCalibration?.assetId === bottomCaseModelId, "Bottom calibration should be saved independently");
    assert(calibratedBottomCase.topModel3dCalibration?.assetId === originalTopCaseModelId, "Saving bottom calibration should preserve top calibration");

    const strictDeleteResponse = await fetch(
      `${baseUrl}/api/cases/${createdCase.id}/models/top/calibration`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: originalTopCaseModelId, unexpected: true }),
      },
    );
    assert(strictDeleteResponse.status === 400, "Calibration delete payloads should reject unknown fields");

    const mismatchedDeleteResponse = await fetch(
      `${baseUrl}/api/cases/${createdCase.id}/models/top/calibration`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: bottomCaseModelId }),
      },
    );
    assert(mismatchedDeleteResponse.status === 409, "Calibration deletion must match the active model hash");

    const caseWithoutTopCalibration = await request<Case>(
      "DELETE",
      `/api/cases/${createdCase.id}/models/top/calibration`,
      { assetId: originalTopCaseModelId },
    );
    assert(caseWithoutTopCalibration.topModel3dCalibration === null, "Calibration delete should clear only the requested half");
    assert(caseWithoutTopCalibration.bottomModel3dCalibration?.assetId === bottomCaseModelId, "Top calibration delete should preserve bottom calibration");
    await request<Case>(
      "PUT",
      `/api/cases/${createdCase.id}/models/top/calibration`,
      topCalibration,
    );

    const replacementTopCaseModelUpload = await uploadCaseModel(
      createdCase.id,
      "top",
      createMinimalGlb("case-top-replacement"),
      "case-top-replacement.glb",
    );
    assert(replacementTopCaseModelUpload.response.ok && replacementTopCaseModelUpload.json?.topModel3dUrl, "Replacing top GLB should succeed");
    assert(replacementTopCaseModelUpload.json.topModel3dCalibration === null, "A different top GLB hash must invalidate top calibration");
    assert(replacementTopCaseModelUpload.json.bottomModel3dCalibration?.assetId === bottomCaseModelId, "Replacing top GLB should preserve bottom calibration");
    assert(!fs.existsSync(originalTopCaseModelPath), "Replaced unreferenced top GLB should be deleted");
    const topCaseModelUrl = replacementTopCaseModelUpload.json.topModel3dUrl;
    const topCaseModelId = topCaseModelUrl.match(/([a-f0-9]{64})\.glb$/)?.[1];
    assert(topCaseModelId, "Replacement top case GLB should use a hash asset ID");
    const topCaseModelPath = path.join(uploadsDir, "models", `${topCaseModelId}.glb`);
    assert(fs.existsSync(topCaseModelPath), "Replacement top case GLB should be published");

    const referencedCaseModelDelete = await request<{ deleted: boolean; referenced: boolean }>(
      "DELETE",
      `/api/models/${topCaseModelId}`,
    );
    assert(!referencedCaseModelDelete.deleted && referencedCaseModelDelete.referenced, "Case-referenced GLBs must not be deleted");

    const caseWithoutTopModel = await request<Case>("DELETE", `/api/cases/${createdCase.id}/models/top`);
    assert(caseWithoutTopModel.topModel3dUrl === null, "Removing the top case model should clear only the top fields");
    assert(caseWithoutTopModel.topModel3dCalibration === null, "Removing a case GLB must clear its calibration");
    assert(caseWithoutTopModel.bottomModel3dUrl === bottomCaseModelUrl, "Removing the top case model should preserve the bottom model");
    assert(caseWithoutTopModel.bottomModel3dCalibration?.assetId === bottomCaseModelId, "Removing the top GLB should preserve bottom calibration");
    assert(!fs.existsSync(topCaseModelPath), "An unreferenced removed top case GLB should be deleted");
    assert(fs.existsSync(bottomCaseModelPath), "The still-referenced bottom case GLB should remain");

    const bundledDelete = await request<{ deleted: boolean; referenced: boolean }>(
      "DELETE",
      `/api/models/${defaultTopModelId}`,
    );
    assert(!bundledDelete.deleted, "Bundled fallback GLBs should remain available after their last association is removed");
    assert(fs.existsSync(path.join(uploadsDir, "models", `${defaultTopModelId}.glb`)), "Bundled fallback GLB should remain in managed uploads");

    const fakeCaseModelUpload = await uploadCaseModel(
      createdCase.id,
      "top",
      Buffer.from("not a glb", "utf8"),
      "fake-case.glb",
    );
    assert(!fakeCaseModelUpload.response.ok, "Case GLB uploads should reject invalid GLB bytes");

    const arbitraryCaseModelPatch = await fetch(`${baseUrl}/api/cases/${createdCase.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topModel3dUrl: "https://example.com/untrusted.glb" }),
    });
    assert(!arbitraryCaseModelPatch.ok, "Case model fields should reject URLs outside managed uploads");

    const managedCaseModelPatch = await fetch(`${baseUrl}/api/cases/${createdCase.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topModel3dUrl: bottomCaseModelUrl }),
    });
    assert(
      !managedCaseModelPatch.ok,
      "Case model fields must only change through reference-aware model endpoints",
    );

    const renamedCase = await request<Case>("PATCH", `/api/cases/${createdCase.id}`, {
      name: "Renamed Verification Case",
    });
    assert(renamedCase.name === "Renamed Verification Case", "Case rename should be saved");

    const createdCaseDetails = await request<CaseWithCompartments>("GET", `/api/cases/${createdCase.id}`);
    const topCompartments = createdCaseDetails.compartments.filter((compartment) => compartment.layer === "top");
    const bottomCompartments = createdCaseDetails.compartments.filter((compartment) => compartment.layer === "bottom");
    assert(topCompartments.length === 24, "Mixed layout should create 24 top compartments");
    assert(bottomCompartments.length === 72, "Mixed layout should create 72 bottom compartments");

    const customCase = await request<Case>("POST", "/api/cases", {
      name: "Custom Verification Case",
      rows: 3,
      cols: 5,
      hasBottom: true,
      description: "Created by the custom case creator flow",
    });
    assert(customCase.model === "CUSTOM-5x3-BOTH", "Custom cases should receive a custom model key");
    assert(customCase.rows === 3, "Custom case should preserve row count");
    assert(customCase.cols === 5, "Custom case should preserve column count");
    assert(customCase.hasBottom === true, "Custom case should preserve bottom layer choice");
    const parsedCustomLayout = safeParseCustomCaseLayout(customCase.layoutGeometry, {
      rows: customCase.rows,
      cols: customCase.cols,
      hasBottom: Boolean(customCase.hasBottom),
    });
    assert(parsedCustomLayout.success, "Custom cases should receive valid uniform layout geometry");
    const originalSecondRow = [...parsedCustomLayout.data.layers.top.columnWidthsByRow[1]];
    const resizedTopLayer = resizeCustomCaseColumnBoundary(
      parsedCustomLayout.data.layers.top,
      0,
      1,
      2_600,
    );
    const resizedLayout = replaceCustomCaseLayer(parsedCustomLayout.data, "top", resizedTopLayer);
    const updatedCustomLayoutCase = await request<Case>("PATCH", `/api/cases/${customCase.id}/layout`, {
      layoutGeometry: resizedLayout,
    });
    assert(
      updatedCustomLayoutCase.layoutGeometry?.layers.top.columnWidthsByRow[0][0] === 2_600,
      "Custom layout should save an independently moved divider",
    );
    assert(
      JSON.stringify(updatedCustomLayoutCase.layoutGeometry?.layers.top.columnWidthsByRow[1]) === JSON.stringify(originalSecondRow),
      "Moving a divider in one row must not resize the same columns in another row",
    );

    const presetLayoutUpdate = await fetch(`${baseUrl}/api/cases/${createdCase.id}/layout`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layoutGeometry: resizedLayout }),
    });
    assert(!presetLayoutUpdate.ok, "Preset cases should reject custom geometry updates");

    const customCaseDetails = await request<CaseWithCompartments>("GET", `/api/cases/${customCase.id}`);
    assert(customCaseDetails.compartments.filter(compartment => compartment.layer === "top").length === 15, "Custom case should create top compartments");
    assert(customCaseDetails.compartments.filter(compartment => compartment.layer === "bottom").length === 15, "Custom case should create bottom compartments");

    const unorganizedCase = await request<Case>("POST", "/api/cases", {
      name: "Unorganized Verification Case",
      model: UNORGANIZED_CASE_MODEL,
      description: "Created by the unorganized list verification flow",
    });
    assert(unorganizedCase.rows === 100, "Unorganized cases should create 100 list rows");
    assert(unorganizedCase.cols === 1, "Unorganized cases should use one list column");
    assert(unorganizedCase.hasBottom === false, "Unorganized cases should not have a bottom layer");

    const unorganizedCaseDetails = await request<CaseWithCompartments>("GET", `/api/cases/${unorganizedCase.id}`);
    assert(unorganizedCaseDetails.compartments.length === 100, "Unorganized cases should create 100 list slots");
    assert(unorganizedCaseDetails.compartments[0].position === "Item 1", "Unorganized list slots should start at Item 1");
    assert(unorganizedCaseDetails.compartments[99].position === "Item 100", "Unorganized list slots should end at Item 100");

    const unorganizedComponent = await request<Component>("POST", "/api/components", {
      compartmentId: unorganizedCaseDetails.compartments[0].id,
      name: "Unorganized Verification Component",
      category: "other",
      quantity: 1,
      minQuantity: 1,
      notes: "List slot probe",
    });
    assert(unorganizedComponent.compartmentId === unorganizedCaseDetails.compartments[0].id, "Unorganized components should save to list slots");

    const casesBeforeReorder = await request<Case[]>("GET", "/api/cases");
    const reorderableCaseIds = casesBeforeReorder
      .filter(case_ => case_.model !== UNSORTED_CASE_MODEL)
      .map(case_ => case_.id)
      .reverse();
    const reorderedCases = await request<Case[]>("PATCH", "/api/cases/reorder", {
      caseIds: reorderableCaseIds,
    });
    assert(reorderedCases[0].model === UNSORTED_CASE_MODEL, "Unsorted case should remain first after reordering");
    assert(
      reorderedCases.filter(case_ => case_.model !== UNSORTED_CASE_MODEL).map(case_ => case_.id).join(",") === reorderableCaseIds.join(","),
      "Case reorder should save the requested physical case order",
    );

    const invalidReorderResponse = await fetch(`${baseUrl}/api/cases/reorder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseIds: reorderableCaseIds.slice(1) }),
    });
    assert(!invalidReorderResponse.ok, "Case reorder should reject incomplete case order payloads");

    const downloadedDatasheet = await request<{ url: string }>("POST", "/api/download/datasheet", {
      url: `${baseUrl}/fixtures/example-datasheet.pdf`,
    });
    assert(downloadedDatasheet.url.startsWith("/uploads/datasheets/"), "Datasheet links should be downloaded to uploads/datasheets");
    assert(fs.existsSync(path.join(uploadsDir, downloadedDatasheet.url.replace("/uploads/", ""))), "Downloaded datasheet file should exist");

    const downloadedPhoto = await request<{ url: string }>("POST", "/api/download/photo", {
      url: `${baseUrl}/fixtures/example-photo.png`,
    });
    assert(downloadedPhoto.url.startsWith("/uploads/photos/"), "Photo links should be downloaded to uploads/photos");
    assert(downloadedPhoto.url.endsWith(".png"), "Direct photo downloads should keep a browser-viewable image extension");
    const downloadedPhotoPath = path.join(uploadsDir, downloadedPhoto.url.replace("/uploads/", ""));
    assert(fs.existsSync(downloadedPhotoPath), "Downloaded photo file should exist");

    const servedPhoto = await fetch(`${baseUrl}${downloadedPhoto.url}`);
    assert(servedPhoto.ok, "Downloaded photo should be served from uploads");
    assert(servedPhoto.headers.get("content-type")?.startsWith("image/png"), "Downloaded photo should be served as an image");

    const downloadedPhotoFromPage = await request<{ url: string }>("POST", "/api/download/photo", {
      url: `${baseUrl}/fixtures/photo-page`,
    });
    assert(downloadedPhotoFromPage.url.startsWith("/uploads/photos/"), "Photo page links should download an image into uploads/photos");
    assert(downloadedPhotoFromPage.url.endsWith(".png"), "Photo page links should resolve to a browser-viewable image file");

    const fakeImageResponse = await fetch(`${baseUrl}/api/download/photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${baseUrl}/fixtures/fake-photo.jpg` }),
    });
    assert(!fakeImageResponse.ok, "Photo downloads should reject HTML bodies even when the response claims image/jpeg");

    const mismatchedCreateRotationResponse = await fetch(`${baseUrl}/api/components`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        compartmentId: topCompartments[0].id,
        name: "Rejected Rotation",
        category: "resistor",
        model3dUrl: uploadedModelAsset.url,
        model3dName: uploadedModelAsset.name,
        model3dSource: uploadedModelAsset.source,
        model3dRotation: createComponentModelRotation("f".repeat(64)),
      }),
    });
    assert(mismatchedCreateRotationResponse.status === 400, "Component creation must reject rotation for a different GLB hash");

    const component = await request<Component>("POST", "/api/components", {
      compartmentId: topCompartments[0].id,
      name: "Verification Resistor",
      category: "resistor",
      packageSize: "custom-0805-tape",
      quantity: 25,
      minQuantity: 5,
      notes: "Initial add test",
      datasheetUrl: downloadedDatasheet.url,
      photoUrl: downloadedPhoto.url,
      model3dUrl: uploadedModelAsset.url,
      model3dName: uploadedModelAsset.name,
      model3dSource: uploadedModelAsset.source,
      model3dRotation: createComponentModelRotation(uploadedModelAsset.assetId, {
        xQuarterTurns: 1,
        yQuarterTurns: 2,
        zQuarterTurns: 3,
      }),
    });
    assert(component.categoryId === 1, "Component category should be normalized from category name");
    assert(component.packageSize === "custom-0805-tape", "Custom component package size should be saved");
    assert(component.datasheetUrl === downloadedDatasheet.url, "Downloaded datasheet path should be saved");
    assert(component.photoUrl === downloadedPhoto.url, "Downloaded photo path should be saved");
    assert(component.model3dUrl === uploadedModelAsset.url, "Converted GLB path should be saved on the component");
    assert(component.model3dName === "Verification Upload", "Model display name should be saved without retaining the original file");
    assert(component.model3dRotation?.xQuarterTurns === 1, "Component model X rotation should be saved");
    assert(component.model3dRotation?.yQuarterTurns === 2, "Component model Y rotation should be saved");
    assert(component.model3dRotation?.zQuarterTurns === 3, "Component model Z rotation should be saved");

    const referencedDelete = await request<{ deleted: boolean; referenced: boolean }>(
      "DELETE",
      `/api/models/${uploadedModelAsset.assetId}`,
    );
    assert(!referencedDelete.deleted && referencedDelete.referenced, "Referenced hash-cached models must not be deleted");
    assert(fs.existsSync(path.join(uploadsDir, "models", `${uploadedModelAsset.assetId}.glb`)), "Referenced GLB should remain on disk");

    const invalidAssociationResponse = await fetch(`${baseUrl}/api/components/${component.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model3dUrl: "/uploads/models/../../outside.glb" }),
    });
    assert(!invalidAssociationResponse.ok, "Component updates should reject non-canonical model URLs");
    const componentAfterFailedReplacement = (await request<Component[]>("GET", "/api/components"))
      .find(item => item.id === component.id);
    assert(componentAfterFailedReplacement?.model3dUrl === uploadedModelAsset.url, "Failed replacement should preserve the existing model association");

    const mismatchedRotationResponse = await fetch(`${baseUrl}/api/components/${component.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model3dRotation: createComponentModelRotation("f".repeat(64)),
      }),
    });
    assert(mismatchedRotationResponse.status === 400, "Rotation must match the active component GLB hash");

    const rotatedComponent = await request<Component>("PATCH", `/api/components/${component.id}`, {
      model3dRotation: createComponentModelRotation(uploadedModelAsset.assetId, {
        xQuarterTurns: 2,
        yQuarterTurns: 1,
        zQuarterTurns: 0,
      }),
    });
    assert(rotatedComponent.model3dRotation?.xQuarterTurns === 2, "Saved model rotation should be editable");

    const sameHashComponentModel = await request<Component>("PATCH", `/api/components/${component.id}`, {
      model3dUrl: uploadedModelAsset.url,
      model3dName: uploadedModelAsset.name,
      model3dSource: uploadedModelAsset.source,
    });
    assert(sameHashComponentModel.model3dRotation?.xQuarterTurns === 2, "Reassigning the same GLB hash should preserve its rotation");

    const editedComponent = await request<Component>("PATCH", `/api/components/${component.id}`, {
      name: "Verification Capacitor",
      category: "capacitor",
      packageSize: "0603",
      quantity: 8,
      minQuantity: 3,
      notes: "Edited component",
    });
    assert(editedComponent.name === "Verification Capacitor", "Edited component name was not saved");
    assert(editedComponent.categoryId === 2, "Edited component category was not saved");
    assert(editedComponent.packageSize === "0603", "Edited component package size was not saved");
    assert(editedComponent.model3dUrl === uploadedModelAsset.url, "Unrelated edits should preserve the model association");
    assert(editedComponent.model3dRotation?.xQuarterTurns === 2, "Unrelated edits should preserve model rotation");

    const replacementComponentModel = await request<Component>("PATCH", `/api/components/${component.id}`, {
      model3dUrl: concurrentModelA.json!.url,
      model3dName: concurrentModelA.json!.name,
      model3dSource: concurrentModelA.json!.source,
    });
    assert(replacementComponentModel.model3dRotation === null, "Replacing a component GLB should clear its saved rotation");

    const restoredComponentModel = await request<Component>("PATCH", `/api/components/${component.id}`, {
      model3dUrl: uploadedModelAsset.url,
      model3dName: uploadedModelAsset.name,
      model3dSource: uploadedModelAsset.source,
      model3dRotation: createComponentModelRotation(uploadedModelAsset.assetId, {
        xQuarterTurns: 3,
        yQuarterTurns: 0,
        zQuarterTurns: 1,
      }),
    });
    assert(restoredComponentModel.model3dRotation?.zQuarterTurns === 1, "A replacement may save rotation for its matching asset");

    const removedComponentModel = await request<Component>("PATCH", `/api/components/${component.id}`, {
      model3dUrl: null,
      model3dName: null,
      model3dSource: null,
    });
    assert(removedComponentModel.model3dRotation === null, "Removing a component GLB should clear its saved rotation");

    const reattachedComponentModel = await request<Component>("PATCH", `/api/components/${component.id}`, {
      model3dUrl: uploadedModelAsset.url,
      model3dName: uploadedModelAsset.name,
      model3dSource: uploadedModelAsset.source,
      model3dRotation: createComponentModelRotation(uploadedModelAsset.assetId, {
        xQuarterTurns: 3,
        yQuarterTurns: 0,
        zQuarterTurns: 1,
      }),
    });
    assert(reattachedComponentModel.model3dRotation?.zQuarterTurns === 1, "A reattached GLB should accept its asset-matched rotation");

    const searchResults = await request<Component[]>("GET", "/api/components/search?q=0603");
    assert(searchResults.some((result) => result.id === component.id), "Search should find components by package size");

    const srvComponent = await request<Component>("POST", "/api/components", {
      compartmentId: topCompartments[1].id,
      name: "SRV054CTP",
      category: "diode",
      packageSize: "SOT-23-6",
      quantity: 2,
      minQuantity: 1,
      notes: "USB ESD protection diode array",
    });

    const bomForm = new FormData();
    bomForm.append("bom", new Blob([
      [
        "Name,Description,Quantity",
        "Verification Capacitor,0603 ceramic capacitor,12",
        "Verification Capacitor,0603 ceramic capacitor,4",
        "SRV05-4,USB ESD protection array,1",
        "Missing Verification Widget,Not in the catalog,1",
      ].join("\n"),
    ], { type: "text/csv" }), "verification-bom.csv");

    const bomResponse = await fetch(`${baseUrl}/api/bom/locate`, {
      method: "POST",
      body: bomForm,
    });
    const bomText = await bomResponse.text();
    assert(bomResponse.ok, `BOM locator should accept CSV uploads: ${bomText}`);
    const bomReport = JSON.parse(bomText) as {
      itemCount: number;
      matchedCount: number;
      shortCount: number;
      missingCount: number;
      pdfUrl: string;
      htmlUrl: string;
      ai: { enabled: boolean; used: boolean };
      items: {
        itemNumber: number;
        status: "matched" | "short" | "missing";
        short: boolean;
        confidence: number;
        name: string;
        matches: { caseName: string; position: string; layer: string }[];
      }[];
    };
    assert(bomReport.itemCount === 4, "BOM report should include every uploaded line item");
    assert(bomReport.matchedCount === 2, "BOM report should count fully stocked matches");
    assert(bomReport.shortCount === 1, "BOM report should flag insufficient inventory with a short count");
    assert(bomReport.missingCount === 1, "BOM report should list missing BOM items");
    assert(bomReport.items.some(item => item.status === "short" && item.short), "Short BOM items should carry a star flag");
    const srvBomItem = bomReport.items.find(item => item.name === "SRV05-4");
    assert(srvBomItem?.status === "matched", "Canonical MPN matching should match SRV05-4 to SRV054CTP");
    assert(srvBomItem.confidence >= 90, "Canonical MPN matches should receive a high confidence percentage");
    assert(
      bomReport.items.some(item => item.status !== "missing" && item.matches.some(match => match.position === topCompartments[0].position)),
      "BOM report should include matched component locations",
    );
    assert(bomReport.ai.enabled === false && bomReport.ai.used === false, "BOM report should skip AI analysis when no Hugging Face token is configured");
    assert(bomReport.pdfUrl.startsWith("/uploads/reports/"), "BOM report should return a printable PDF URL");
    const bomPdfPath = path.join(uploadsDir, bomReport.pdfUrl.replace("/uploads/", ""));
    assert(fs.existsSync(bomPdfPath), "BOM report PDF should be written to uploads/reports");
    assert(fs.readFileSync(bomPdfPath).subarray(0, 4).toString("utf8") === "%PDF", "BOM report should be a PDF file");
    const servedBomPdf = await fetch(`${baseUrl}${bomReport.pdfUrl}`);
    assert(servedBomPdf.ok, "BOM report PDF should be served from uploads");
    assert(bomReport.htmlUrl.startsWith("/uploads/reports/"), "BOM report should return an interactive web report URL");
    assert(bomReport.htmlUrl.endsWith(".html"), "Interactive BOM report should be an HTML file");
    const bomHtmlPath = path.join(uploadsDir, bomReport.htmlUrl.replace("/uploads/", ""));
    assert(fs.existsSync(bomHtmlPath), "Interactive BOM report should be written to uploads/reports");
    assert(fs.readFileSync(bomHtmlPath, "utf8").startsWith("<!doctype html>"), "Interactive BOM report should be HTML");
    const servedBomHtml = await fetch(`${baseUrl}${bomReport.htmlUrl}`);
    assert(servedBomHtml.ok, "Interactive BOM report should be served from uploads");

    const checkedOut = await request<Component>("POST", `/api/components/${component.id}/checkout`, {
      checkedOutBy: "Verifier",
    });
    assert(checkedOut.checkedOut === true, "Checkout should mark a component checked out");

    const returned = await request<Component>("POST", `/api/components/${component.id}/return`);
    assert(returned.checkedOut === false, "Return should clear checkout state");

    const exportedCases = await request<Case[]>("GET", "/api/cases");
    const exportedComponents = await request<Component[]>("GET", "/api/components");
    const exportedTools = await request<Tool[]>("GET", "/api/tools");
    const exportedAdapters = await request<Adapter[]>("GET", "/api/adapters");
    const exportedDetails = await Promise.all(
      exportedCases.map((case_) => request<CaseWithCompartments>("GET", `/api/cases/${case_.id}`)),
    );
    const exportData = {
      cases: exportedDetails,
      components: exportedComponents,
      tools: exportedTools,
      adapters: exportedAdapters,
      exportDate: new Date().toISOString(),
      version: "8.0",
    };
    assert(exportData.cases.some((case_) => case_.id === createdCase.id), "Export data should include created cases");
    assert(exportData.components.some((item) => item.id === component.id), "Export data should include created components");
    assert(exportData.tools.some((item) => item.id === oscilloscope.id), "Export data should include created tools");
    assert(exportData.adapters.some((item) => item.id === debugAdapter.id), "Export data should include created adapters");

    const sourceCase = exportData.cases.find((case_) => case_.id === createdCase.id);
    assert(sourceCase, "Expected exported source case");
    const sourceComponent = exportData.components.find((item) => item.id === component.id);
    assert(sourceComponent, "Expected exported source component");
    const sourceTool = exportData.tools.find((item) => item.id === oscilloscope.id);
    assert(sourceTool, "Expected exported source tool");
    const sourceAdapter = exportData.adapters.find((item) => item.id === debugAdapter.id);
    assert(sourceAdapter, "Expected exported source adapter");
    const sourceCompartment = sourceCase.compartments.find((compartment) => compartment.id === sourceComponent.compartmentId);
    assert(sourceCompartment, "Expected exported source compartment");

    const mismatchedImportCalibrationResponse = await fetch(`${baseUrl}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid Calibration Import",
        model: sourceCase.model,
        bottomModel3dUrl: sourceCase.bottomModel3dUrl,
        bottomModel3dName: sourceCase.bottomModel3dName,
        bottomModel3dSource: sourceCase.bottomModel3dSource,
        bottomModel3dCalibration: sourceCase.bottomModel3dCalibration
          ? { ...sourceCase.bottomModel3dCalibration, assetId: "0".repeat(64) }
          : createCaseModelCalibration("0".repeat(64)),
      }),
    });
    assert(mismatchedImportCalibrationResponse.status === 400, "JSON imports must reject calibration for a different model hash");

    const importedCase = await request<Case>("POST", "/api/cases", {
      name: `${sourceCase.name} Imported`,
      model: sourceCase.model,
      rows: sourceCase.rows,
      cols: sourceCase.cols,
      hasBottom: sourceCase.hasBottom,
      description: sourceCase.description || "",
      closedImageUrl: sourceCase.closedImageUrl,
      openImageUrl: sourceCase.openImageUrl,
      topModel3dUrl: sourceCase.topModel3dUrl,
      topModel3dName: sourceCase.topModel3dName,
      topModel3dSource: sourceCase.topModel3dSource,
      topModel3dCalibration: sourceCase.topModel3dCalibration,
      bottomModel3dUrl: sourceCase.bottomModel3dUrl,
      bottomModel3dName: sourceCase.bottomModel3dName,
      bottomModel3dSource: sourceCase.bottomModel3dSource,
      bottomModel3dCalibration: sourceCase.bottomModel3dCalibration,
      layoutGeometry: sourceCase.layoutGeometry,
    });
    assert(importedCase.closedImageUrl === sourceCase.closedImageUrl, "JSON import should preserve a managed closed-case image URL");
    assert(importedCase.topModel3dUrl === defaultTopModelUrl, "A missing imported preset top model should receive the bundled fallback");
    assert(importedCase.bottomModel3dUrl === sourceCase.bottomModel3dUrl, "JSON import should preserve a managed bottom case GLB URL");
    assert(
      importedCase.bottomModel3dCalibration?.assetId === sourceCase.bottomModel3dCalibration?.assetId,
      "JSON v5 import should preserve calibration for the matching model asset",
    );
    const importedCaseDetails = await request<CaseWithCompartments>("GET", `/api/cases/${importedCase.id}`);
    const importedCompartment = importedCaseDetails.compartments.find((compartment) =>
      compartment.position === sourceCompartment.position && compartment.layer === sourceCompartment.layer
    );
    assert(importedCompartment, "Import mapping should find the matching compartment by position and layer");

    const importedComponent = await request<Component>("POST", "/api/components", {
      name: sourceComponent.name,
      compartmentId: importedCompartment.id,
      categoryId: sourceComponent.categoryId,
      packageSize: sourceComponent.packageSize,
      quantity: sourceComponent.quantity,
      minQuantity: sourceComponent.minQuantity,
      datasheetUrl: sourceComponent.datasheetUrl,
      photoUrl: sourceComponent.photoUrl,
      model3dUrl: sourceComponent.model3dUrl,
      model3dName: sourceComponent.model3dName,
      model3dSource: sourceComponent.model3dSource,
      model3dRotation: sourceComponent.model3dRotation,
      notes: sourceComponent.notes,
    });
    assert(importedComponent.compartmentId === importedCompartment.id, "Imported component should use the mapped compartment");
    assert(importedComponent.model3dUrl === uploadedModelAsset.url, "JSON import should preserve a valid local GLB association");
    assert(
      importedComponent.model3dRotation?.assetId === uploadedModelAsset.assetId,
      "JSON v5 import should preserve asset-matched component rotation",
    );

    const importedTool = await request<Tool>("POST", "/api/tools", {
      name: `${sourceTool.name} Imported`,
      category: sourceTool.category,
      manufacturer: sourceTool.manufacturer,
      modelNumber: sourceTool.modelNumber,
      productUrl: sourceTool.productUrl,
      imageUrl: sourceTool.imageUrl,
      quantity: sourceTool.quantity,
      location: sourceTool.location,
      capabilities: sourceTool.capabilities,
      notes: sourceTool.notes,
    });
    assert(importedTool.category === sourceTool.category, "JSON v5 import should preserve a tool category");
    assert(importedTool.manufacturer === sourceTool.manufacturer, "JSON v5 import should preserve a tool manufacturer");
    assert(importedTool.modelNumber === sourceTool.modelNumber, "JSON v5 import should preserve a tool model number");
    assert(importedTool.productUrl === sourceTool.productUrl, "JSON import should preserve a tool product URL");
    assert(importedTool.imageUrl === sourceTool.imageUrl, "JSON import should preserve a tool image URL");
    assert(importedTool.quantity === sourceTool.quantity, "JSON v5 import should preserve a tool quantity");
    assert(importedTool.location === sourceTool.location, "JSON v5 import should preserve a tool location");
    assert(importedTool.capabilities === sourceTool.capabilities, "JSON v5 import should preserve tool capabilities");
    assert(importedTool.notes === sourceTool.notes, "JSON v5 import should preserve tool notes");

    const importedAdapter = await request<Adapter>("POST", "/api/adapters", {
      name: `${sourceAdapter.name} Imported`,
      category: sourceAdapter.category,
      manufacturer: sourceAdapter.manufacturer,
      modelNumber: sourceAdapter.modelNumber,
      productUrl: sourceAdapter.productUrl,
      imageUrl: sourceAdapter.imageUrl,
      endpointA: sourceAdapter.endpointA,
      endpointAType: sourceAdapter.endpointAType,
      endpointB: sourceAdapter.endpointB,
      endpointBType: sourceAdapter.endpointBType,
      quantity: sourceAdapter.quantity,
      location: sourceAdapter.location,
      compatibility: sourceAdapter.compatibility,
      notes: sourceAdapter.notes,
    });
    assert(importedAdapter.category === sourceAdapter.category, "JSON import should preserve an adapter category");
    assert(importedAdapter.manufacturer === sourceAdapter.manufacturer, "JSON import should preserve an adapter manufacturer");
    assert(importedAdapter.modelNumber === sourceAdapter.modelNumber, "JSON import should preserve an adapter model number");
    assert(importedAdapter.productUrl === sourceAdapter.productUrl, "JSON import should preserve an adapter product URL");
    assert(importedAdapter.imageUrl === sourceAdapter.imageUrl, "JSON import should preserve an adapter image URL");
    assert(importedAdapter.endpointA === sourceAdapter.endpointA, "JSON import should preserve adapter endpoint A");
    assert(importedAdapter.endpointAType === sourceAdapter.endpointAType, "JSON import should preserve adapter endpoint A type");
    assert(importedAdapter.endpointB === sourceAdapter.endpointB, "JSON import should preserve adapter endpoint B");
    assert(importedAdapter.endpointBType === sourceAdapter.endpointBType, "JSON import should preserve adapter endpoint B type");
    assert(importedAdapter.quantity === sourceAdapter.quantity, "JSON import should preserve an adapter quantity");
    assert(importedAdapter.location === sourceAdapter.location, "JSON import should preserve an adapter location");
    assert(importedAdapter.compatibility === sourceAdapter.compatibility, "JSON import should preserve adapter compatibility");
    assert(importedAdapter.notes === sourceAdapter.notes, "JSON import should preserve adapter notes");

    await request("DELETE", `/api/components/${importedComponent.id}`);
    await request("DELETE", `/api/components/${unorganizedComponent.id}`);
    await request("DELETE", `/api/components/${srvComponent.id}`);
    await request("DELETE", `/api/components/${component.id}`);
    await request("DELETE", `/api/component-books/${componentBook.id}`);
    const deletedBookResponse = await fetch(`${baseUrl}/api/component-books/${componentBook.id}`);
    assert(deletedBookResponse.status === 404, "Deleted component books should not remain");
    const deletedBookItemSearch = await request<ComponentBookSearchResult[]>(
      "GET",
      "/api/component-book-items/search?q=C0603-100N",
    );
    assert(deletedBookItemSearch.length === 0, "Deleting a component book should cascade to its line items");
    await request("DELETE", `/api/tools/${importedTool.id}`);
    await request("DELETE", `/api/tools/${oscilloscope.id}`);
    await request("DELETE", `/api/adapters/${importedAdapter.id}`);
    await request("DELETE", `/api/adapters/${debugAdapter.id}`);
    const unreferencedDelete = await request<{ deleted: boolean; referenced: boolean }>(
      "DELETE",
      `/api/models/${uploadedModelAsset.assetId}`,
    );
    assert(unreferencedDelete.deleted && !unreferencedDelete.referenced, "Unreferenced GLB should be removable");
    assert(!fs.existsSync(path.join(uploadsDir, "models", `${uploadedModelAsset.assetId}.glb`)), "Removed GLB should leave permanent storage");
    await request("DELETE", `/api/cases/${importedCase.id}`);
    await request("DELETE", `/api/cases/${unorganizedCase.id}`);
    await request("DELETE", `/api/cases/${customCase.id}`);
    await request("DELETE", `/api/cases/${createdCase.id}`);
    assert(!fs.existsSync(closedImagePath), "Deleting the last case image reference should remove the uploaded file");
    assert(!fs.existsSync(bottomCaseModelPath), "Deleting the last case GLB reference should remove the uploaded model");

    const remainingComponents = await request<Component[]>("GET", "/api/components");
    assert(!remainingComponents.some((item) =>
      item.id === component.id ||
      item.id === importedComponent.id ||
      item.id === unorganizedComponent.id ||
      item.id === srvComponent.id
    ), "Deleted components should not remain");

    const remainingTools = await request<Tool[]>("GET", "/api/tools");
    assert(
      !remainingTools.some(item => item.id === oscilloscope.id || item.id === importedTool.id),
      "Deleted tools should not remain",
    );
    const remainingAdapters = await request<Adapter[]>("GET", "/api/adapters");
    assert(
      !remainingAdapters.some(item => item.id === debugAdapter.id || item.id === importedAdapter.id),
      "Deleted adapters should not remain",
    );

    const remainingCases = await request<Case[]>("GET", "/api/cases");
    assert(!remainingCases.some((case_) => case_.id === createdCase.id || case_.id === importedCase.id || case_.id === customCase.id || case_.id === unorganizedCase.id), "Deleted cases should not remain in active cases");

    console.log("Verification passed: components, tools, adapters, and component books support add, edit, delete, import, export, search, checkout, and return flows.");
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runPersistenceWorker(mode: "write" | "read", storageFile: string) {
  const tempRoot = path.dirname(storageFile);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/verify-persistence-worker.ts", mode],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STORAGE_FILE: storageFile,
        UPLOADS_DIR: path.join(tempRoot, "uploads"),
        MODEL_TEMP_DIR: path.join(tempRoot, "model-temp"),
        KICAD_SETTINGS_FILE: path.join(tempRoot, "kicad-settings.json"),
      },
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `Persistence worker ${mode} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
}

function verifyPersistenceAcrossRestart() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "component-catalog-persistence-test-"));
  const storageFile = path.join(tempDir, "storage.json");

  try {
    runPersistenceWorker("write", storageFile);
    runPersistenceWorker("read", storageFile);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyLegacyDefaultBackfillRunsOnce() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "component-catalog-default-backfill-test-"));
  const storageFile = path.join(tempDir, "storage.json");
  const userTopUrl = `/uploads/models/${"f".repeat(64)}.glb`;

  try {
    fs.writeFileSync(storageFile, JSON.stringify({
      version: 4,
      counters: {
        userIdCounter: 1,
        caseIdCounter: 2,
        compartmentIdCounter: 2,
        componentIdCounter: 2,
      },
      users: [],
      cases: [{
        id: 1,
        name: "Legacy Preset",
        model: "LAYOUT-6x4-BOTH",
        rows: 4,
        cols: 6,
        hasBottom: true,
        description: null,
        topModel3dUrl: userTopUrl,
        topModel3dName: "User-selected top",
        topModel3dSource: "upload",
        topModel3dCalibration: createCaseModelCalibration("f".repeat(64)),
        bottomModel3dUrl: null,
        bottomModel3dName: null,
        bottomModel3dSource: null,
        bottomModel3dCalibration: createCaseModelCalibration("e".repeat(64)),
        sortOrder: 0,
        isActive: true,
      }],
      compartments: [{
        id: 1,
        caseId: 1,
        position: "A1",
        row: 1,
        col: 1,
        layer: "top",
      }],
      components: [{
        id: 1,
        compartmentId: 1,
        name: "Legacy rotated component",
        categoryId: 12,
        quantity: 1,
        model3dUrl: userTopUrl,
        model3dName: "Legacy model",
        model3dSource: "upload",
        model3dRotation: createComponentModelRotation("e".repeat(64)),
      }],
    }, null, 2));

    const [storageModule, modelModule, defaultsModule] = await Promise.all([
      import("../server/storage"),
      import("../server/model-assets"),
      import("../server/default-case-models"),
    ]);
    const legacyStorage = new storageModule.JsonFileStorage(storageFile);
    assert((await legacyStorage.getTools()).length === 0, "Legacy JSON state without tools should load an empty tools section");
    const migratedLegacyTool = await legacyStorage.createTool({
      name: "Legacy Migration Probe",
      category: "Probe",
      manufacturer: null,
      modelNumber: null,
      quantity: 1,
      location: null,
      capabilities: "Continuity testing",
      notes: null,
    });
    assert(migratedLegacyTool.id === 1, "Legacy JSON state without a tool counter should allocate the first tool ID");
    const modelService = new modelModule.ModelAssetService({
      uploadsRoot: path.join(tempDir, "uploads"),
      storage: legacyStorage,
      settingsFile: path.join(tempDir, "kicad-settings.json"),
      tempRoot: path.join(tempDir, "model-temp"),
    });
    const catalog = await defaultsModule.loadDefaultCaseModelCatalog(
      modelService,
      path.join(process.cwd(), "default-cases"),
    );
    assert(defaultsModule.isCompleteDefaultCaseModelCatalog(catalog), "Expected all three bundled preset GLBs to load");
    assert(await legacyStorage.needsDefaultCaseModelBackfill(), "Legacy JSON state should request a one-time default-model backfill");
    await defaultsModule.seedMissingDefaultCaseModels(legacyStorage, catalog);
    await legacyStorage.completeDefaultCaseModelBackfill();

    const migratedCase = await legacyStorage.getCase(1);
    assert(migratedCase?.topModel3dUrl === userTopUrl, "Legacy backfill must not replace a user-selected top model");
    assert(migratedCase?.topModel3dCalibration?.assetId === "f".repeat(64), "Matching legacy calibration should survive JSON migration");
    assert(migratedCase?.bottomModel3dName === "variant", "Legacy backfill should fill only the missing preset half");
    assert(migratedCase?.bottomModel3dCalibration === null, "Calibration without a matching active GLB should be discarded during migration");
    const migratedComponent = await legacyStorage.getComponent(1);
    assert(migratedComponent?.model3dRotation === null, "Asset-mismatched legacy component rotation should be discarded");

    await legacyStorage.updateCase(1, {
      bottomModel3dUrl: null,
      bottomModel3dName: null,
      bottomModel3dSource: null,
    });
    const reloadedStorage = new storageModule.JsonFileStorage(storageFile);
    assert(!await reloadedStorage.needsDefaultCaseModelBackfill(), "Completed default-model backfill should not repeat");
    const reloadedLegacyTools = await reloadedStorage.getTools();
    assert(
      reloadedLegacyTools.length === 1 && reloadedLegacyTools[0].id === migratedLegacyTool.id,
      "A tool added after loading legacy JSON should survive migration and restart",
    );
    const reloadedCase = await reloadedStorage.getCase(1);
    assert(reloadedCase?.topModel3dUrl === userTopUrl, "User-selected model should survive JSON reload");
    assert(reloadedCase?.bottomModel3dUrl === null, "A model removed after migration must stay removed after restart");
    const migratedState = JSON.parse(fs.readFileSync(storageFile, "utf8")) as { version?: number };
    assert(migratedState.version === 11, "Completed legacy migration should write JSON storage version 11");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyVersion7ToolsCompatibility() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "component-catalog-v7-tools-test-"));
  const storageFile = path.join(tempDir, "storage.json");

  try {
    fs.writeFileSync(storageFile, JSON.stringify({
      version: 7,
      counters: {
        userIdCounter: 1,
        caseIdCounter: 2,
        compartmentIdCounter: 2,
        componentIdCounter: 1,
      },
      users: [],
      cases: [{
        id: 1,
        name: UNSORTED_CASE_NAME,
        model: UNSORTED_CASE_MODEL,
        rows: UNSORTED_CASE_ROWS,
        cols: UNSORTED_CASE_COLS,
        hasBottom: false,
        description: null,
        closedImageUrl: null,
        openImageUrl: null,
        topModel3dUrl: null,
        topModel3dName: null,
        topModel3dSource: null,
        topModel3dCalibration: null,
        bottomModel3dUrl: null,
        bottomModel3dName: null,
        bottomModel3dSource: null,
        bottomModel3dCalibration: null,
        layoutGeometry: null,
        sortOrder: -1,
        isActive: true,
      }],
      compartments: [{
        id: 1,
        caseId: 1,
        position: "A1",
        row: 1,
        col: 1,
        layer: "top",
      }],
      components: [],
    }, null, 2));

    const { JsonFileStorage } = await import("../server/storage");
    const storage = new JsonFileStorage(storageFile);
    assert((await storage.getTools()).length === 0, "Version 7 state should expose an empty tools collection");
    assert((await storage.getAdapters()).length === 0, "Version 7 state should expose an empty adapters collection");
    assert((await storage.getComponentBooks()).length === 0, "Version 7 state should expose an empty component books collection");
    const unopenedState = JSON.parse(fs.readFileSync(storageFile, "utf8")) as { version?: number; tools?: unknown };
    assert(unopenedState.version === 7, "Opening version 7 state should not rewrite the live catalog");
    assert(unopenedState.tools === undefined, "Opening version 7 state should not add fields before a real mutation");

    await storage.createTool({
      name: "Version 7 Upgrade Probe",
      category: "Probe",
      quantity: 1,
    });
    const upgradedState = JSON.parse(fs.readFileSync(storageFile, "utf8")) as {
      version?: number;
      tools?: Tool[];
      counters?: { toolIdCounter?: number };
    };
    assert(upgradedState.version === 11, "The next real version 7 mutation should persist version 11");
    assert(upgradedState.tools?.length === 1, "The version 11 write should include tools");
    assert(upgradedState.counters?.toolIdCounter === 2, "The version 11 write should include the next tool ID");

    const version8File = path.join(tempDir, "storage-v8.json");
    const version8State = JSON.parse(fs.readFileSync(storageFile, "utf8")) as Record<string, unknown> & {
      version: number;
      counters: Record<string, unknown>;
      tools: Array<Record<string, unknown>>;
    };
    version8State.version = 8;
    delete version8State.componentBooks;
    delete version8State.componentBookItems;
    delete version8State.adapters;
    delete version8State.counters.componentBookIdCounter;
    delete version8State.counters.componentBookItemIdCounter;
    delete version8State.counters.adapterIdCounter;
    for (const tool of version8State.tools) {
      delete tool.productUrl;
      delete tool.imageUrl;
    }
    fs.writeFileSync(version8File, JSON.stringify(version8State, null, 2));

    const version8Storage = new JsonFileStorage(version8File);
    const version8Tool = (await version8Storage.getTools())[0];
    assert(version8Tool.productUrl === null, "Version 8 tools should default a missing product URL to null");
    assert(version8Tool.imageUrl === null, "Version 8 tools should default a missing image URL to null");
    assert((await version8Storage.getComponentBooks()).length === 0, "Version 8 state should expose no implicit component books");
    assert((await version8Storage.getAdapters()).length === 0, "Version 8 state should expose no implicit adapters");
    const unopenedVersion8State = JSON.parse(fs.readFileSync(version8File, "utf8")) as { version?: number };
    assert(unopenedVersion8State.version === 8, "Opening version 8 state should not rewrite the live catalog");

    await version8Storage.createComponentBook({
      name: "Version 8 Upgrade Book",
      packageSize: "0805",
    });
    const upgradedVersion8State = JSON.parse(fs.readFileSync(version8File, "utf8")) as {
      version?: number;
      componentBooks?: ComponentBook[];
    };
    assert(upgradedVersion8State.version === 11, "The next real version 8 mutation should persist version 11");
    assert(upgradedVersion8State.componentBooks?.length === 1, "The version 11 write should include component books");

    const version9File = path.join(tempDir, "storage-v9.json");
    const version9State = JSON.parse(fs.readFileSync(version8File, "utf8")) as Record<string, unknown> & {
      version: number;
      counters: Record<string, unknown>;
    };
    version9State.version = 9;
    delete version9State.adapters;
    delete version9State.counters.adapterIdCounter;
    fs.writeFileSync(version9File, JSON.stringify(version9State, null, 2));

    const version9Storage = new JsonFileStorage(version9File);
    assert((await version9Storage.getAdapters()).length === 0, "Version 9 state should expose an empty adapters collection");
    const unopenedVersion9State = JSON.parse(fs.readFileSync(version9File, "utf8")) as { version?: number };
    assert(unopenedVersion9State.version === 9, "Opening version 9 state should not rewrite the live catalog");

    const migratedAdapter = await version9Storage.createAdapter({
      name: "Version 9 Upgrade Adapter",
      category: "Programming Adapter",
      compatibility: "10-pin Cortex Debug to 6-pin SWD",
      quantity: 1,
    });
    assert(migratedAdapter.id === 1, "Version 9 state without an adapter counter should allocate the first adapter ID");
    const upgradedVersion9State = JSON.parse(fs.readFileSync(version9File, "utf8")) as {
      version?: number;
      adapters?: Adapter[];
      counters?: { adapterIdCounter?: number };
    };
    assert(upgradedVersion9State.version === 11, "The next real version 9 mutation should persist version 11");
    assert(upgradedVersion9State.adapters?.length === 1, "The version 11 write should include adapters");
    assert(upgradedVersion9State.adapters?.[0].endpointA === null, "Version 9 adapters without endpoint metadata should normalize it to null");
    assert(upgradedVersion9State.counters?.adapterIdCounter === 2, "The version 11 write should include the next adapter ID");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(() => {
  verifyPersistenceAcrossRestart();
  return verifyLegacyDefaultBackfillRunsOnce();
}).then(() => {
  return verifyVersion7ToolsCompatibility();
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
