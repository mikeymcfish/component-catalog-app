import express from "express";
import fs from "node:fs";
import { registerRoutes } from "../server/routes";
import type {
  Case,
  CaseWithCompartments,
  Component,
  ComponentBook,
  ComponentBookWithItems,
  Adapter,
  Tool,
} from "../shared/schema";
import type { CaseModelCalibration } from "../shared/model-calibration";
import {
  createUniformCustomCaseLayout,
  replaceCustomCaseLayer,
  resizeCustomCaseColumnBoundary,
} from "../shared/custom-case-layout";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createCaseModelCalibration(assetId: string): CaseModelCalibration {
  return {
    version: 1,
    assetId,
    metersPerModelUnit: 0.001,
    origin: { x: 1, y: 2, z: 3 },
    columnAxis: { x: 19, y: 0, z: 0 },
    rowAxis: { x: 0, y: -19, z: 0 },
    outwardNormal: { x: 0, y: 0, z: 1 },
    anchorOverrides: { A1: { x: 0.5, y: -0.5, z: -17 } },
  };
}

const mode = process.argv[2];
assert(mode === "write" || mode === "read", "Expected mode to be write or read");
assert(process.env.STORAGE_FILE, "STORAGE_FILE is required for persistence verification");

const app = express();
app.use(express.json());

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

try {
  if (mode === "write") {
    const uniformLayout = createUniformCustomCaseLayout(3, 4, false);
    const adjustedLayout = replaceCustomCaseLayer(
      uniformLayout,
      "top",
      resizeCustomCaseColumnBoundary(uniformLayout.layers.top, 1, 2, 5_600),
    );
    const savedCase = await request<Case>("POST", "/api/cases", {
      name: "Persisted Verification Case",
      model: "CUSTOM-4x3-TOP",
      rows: 3,
      cols: 4,
      hasBottom: false,
      description: "Written before simulated restart",
      closedImageUrl: `/uploads/case-images/${"b".repeat(64)}.png`,
      openImageUrl: `/uploads/case-images/${"c".repeat(64)}.webp`,
      topModel3dUrl: `/uploads/models/${"d".repeat(64)}.glb`,
      topModel3dName: "Persisted top half",
      topModel3dSource: "upload",
      topModel3dCalibration: createCaseModelCalibration("d".repeat(64)),
      bottomModel3dUrl: `/uploads/models/${"e".repeat(64)}.glb`,
      bottomModel3dName: "Persisted bottom half",
      bottomModel3dSource: "upload",
      bottomModel3dCalibration: createCaseModelCalibration("e".repeat(64)),
      layoutGeometry: adjustedLayout,
    });
    const savedCaseDetails = await request<CaseWithCompartments>("GET", `/api/cases/${savedCase.id}`);

    const oneHalfPreset = await request<Case>("POST", "/api/cases", {
      name: "Persisted One-Half Preset",
      model: "LAYOUT-6x4-BOTH",
      description: "Verifies that clearing one bundled half survives restart",
    });
    assert(oneHalfPreset.topModel3dName === "variant", "New preset should receive the bundled top model");
    assert(oneHalfPreset.bottomModel3dName === "variant", "New preset should receive the bundled bottom model");
    const oneHalfPresetAfterRemoval = await request<Case>(
      "DELETE",
      `/api/cases/${oneHalfPreset.id}/models/top`,
    );
    assert(oneHalfPresetAfterRemoval.topModel3dUrl === null, "Top preset model should be independently removable");
    assert(oneHalfPresetAfterRemoval.bottomModel3dUrl !== null, "Removing top should preserve the bottom preset model");

    await request<Component>("POST", "/api/components", {
      compartmentId: savedCaseDetails.compartments[0].id,
      name: "Persisted Verification Component",
      category: "ic",
      packageSize: "SOIC-8",
      quantity: 42,
      minQuantity: 5,
      notes: "Persistence probe",
      model3dUrl: `/uploads/models/${"a".repeat(64)}.glb`,
      model3dName: "Persisted SOIC-8",
      model3dSource: "upload",
      model3dRotation: {
        version: 1,
        assetId: "a".repeat(64),
        xQuarterTurns: 1,
        yQuarterTurns: 2,
        zQuarterTurns: 3,
      },
    });

    const savedTool = await request<Tool>("POST", "/api/tools", {
      name: "Persisted Verification Oscilloscope",
      category: "Oscilloscope",
      manufacturer: "Keysight",
      modelNumber: "DSOX1204G",
      productUrl: "https://example.com/tools/dsox1204g",
      imageUrl: "https://example.com/images/dsox1204g.jpg",
      quantity: 2,
      location: "Persistence bench",
      capabilities: "4 channels, 70 MHz bandwidth, waveform generator",
      notes: "Saved before simulated restart",
    });
    assert(savedTool.id > 0, "Persisted tool should receive an ID");

    const savedAdapter = await request<Adapter>("POST", "/api/adapters", {
      name: "Persisted Verification SWD Adapter",
      category: "Programming Adapter",
      manufacturer: "Persistence Labs",
      modelNumber: "SWD-10-6",
      productUrl: "https://example.com/adapters/swd-10-6",
      imageUrl: "https://example.com/images/swd-10-6.jpg",
      endpointA: "10-pin 1.27 mm Cortex Debug header",
      endpointAType: "debug-header",
      endpointB: "6-pin 2.54 mm SWD header",
      endpointBType: "pin-header",
      quantity: 2,
      location: "Persistence adapter drawer",
      compatibility: "10-pin 1.27 mm Cortex Debug to 6-pin 2.54 mm SWD; 1.8-5 V targets",
      notes: "Saved before simulated restart",
    });
    assert(savedAdapter.id > 0, "Persisted adapter should receive an ID");

    const savedBook = await request<ComponentBook>("POST", "/api/component-books", {
      name: "Persisted 0805 Book",
      manufacturer: "Persistence Parts",
      packageSize: "0805",
      productUrl: "https://example.com/books/0805",
      imageUrl: "https://example.com/images/0805-book.jpg",
    });
    await request("POST", `/api/component-books/${savedBook.id}/items`, {
      name: "4.7 kΩ resistor",
      category: "Resistor",
      value: "4.7 kΩ",
      packageSize: "0805",
      quantity: 25,
    });

    console.log("Persistence write worker saved probe data.");
  } else {
    const cases = await request<Case[]>("GET", "/api/cases");
    const persistedCase = cases.find(case_ => case_.name === "Persisted Verification Case");
    assert(persistedCase, "Persisted case was not loaded after restart");
    assert(persistedCase.closedImageUrl === `/uploads/case-images/${"b".repeat(64)}.png`, "Persisted closed-case image URL was not preserved");
    assert(persistedCase.openImageUrl === `/uploads/case-images/${"c".repeat(64)}.webp`, "Persisted open-case image URL was not preserved");
    assert(persistedCase.topModel3dUrl === `/uploads/models/${"d".repeat(64)}.glb`, "Persisted top case GLB URL was not preserved");
    assert(persistedCase.bottomModel3dUrl === `/uploads/models/${"e".repeat(64)}.glb`, "Persisted bottom case GLB URL was not preserved");
    assert(persistedCase.topModel3dCalibration?.assetId === "d".repeat(64), "Persisted top calibration was not preserved");
    assert(persistedCase.bottomModel3dCalibration?.assetId === "e".repeat(64), "Persisted bottom calibration was not preserved");
    const persistedState = JSON.parse(fs.readFileSync(process.env.STORAGE_FILE!, "utf8")) as { version?: number };
    assert(persistedState.version === 11, "JSON storage should be migrated to version 11");

    const oneHalfPreset = cases.find(case_ => case_.name === "Persisted One-Half Preset");
    assert(oneHalfPreset, "One-half preset was not loaded after restart");
    assert(oneHalfPreset.topModel3dUrl === null, "A deliberately removed bundled top model must not reappear after restart");
    assert(oneHalfPreset.bottomModel3dName === "variant", "The independently saved bottom model should survive restart");
    assert(/^\/uploads\/models\/[a-f0-9]{64}\.glb$/.test(oneHalfPreset.bottomModel3dUrl || ""), "Persisted bottom preset model should retain its managed URL");
    assert(
      persistedCase.layoutGeometry?.layers.top.columnWidthsByRow[1][1] === 3_100,
      "Persisted custom divider geometry was not preserved",
    );

    const caseDetails = await request<CaseWithCompartments>("GET", `/api/cases/${persistedCase.id}`);
    const persistedComponent = caseDetails.compartments
      .map(compartment => compartment.component)
      .find(component => component?.name === "Persisted Verification Component");

    assert(persistedComponent, "Persisted component was not loaded after restart");
    assert(persistedComponent.packageSize === "SOIC-8", "Persisted component package size was not preserved");
    assert(persistedComponent.quantity === 42, "Persisted component quantity was not preserved");
    assert(persistedComponent.model3dUrl === `/uploads/models/${"a".repeat(64)}.glb`, "Persisted model URL was not preserved");
    assert(persistedComponent.model3dName === "Persisted SOIC-8", "Persisted model name was not preserved");
    assert(persistedComponent.model3dSource === "upload", "Persisted model source was not preserved");
    assert(persistedComponent.model3dRotation?.xQuarterTurns === 1, "Persisted model X rotation was not preserved");
    assert(persistedComponent.model3dRotation?.yQuarterTurns === 2, "Persisted model Y rotation was not preserved");
    assert(persistedComponent.model3dRotation?.zQuarterTurns === 3, "Persisted model Z rotation was not preserved");

    const tools = await request<Tool[]>("GET", "/api/tools");
    const persistedTool = tools.find(tool => tool.name === "Persisted Verification Oscilloscope");
    assert(persistedTool, "Persisted tool was not loaded after restart");
    assert(persistedTool.category === "Oscilloscope", "Persisted tool category was not preserved");
    assert(persistedTool.manufacturer === "Keysight", "Persisted tool manufacturer was not preserved");
    assert(persistedTool.modelNumber === "DSOX1204G", "Persisted tool model number was not preserved");
    assert(persistedTool.productUrl?.endsWith("/dsox1204g"), "Persisted tool product URL was not preserved");
    assert(persistedTool.imageUrl?.endsWith("/dsox1204g.jpg"), "Persisted tool image URL was not preserved");
    assert(persistedTool.quantity === 2, "Persisted tool quantity was not preserved");
    assert(persistedTool.location === "Persistence bench", "Persisted tool location was not preserved");
    assert(persistedTool.capabilities?.includes("waveform generator"), "Persisted tool capabilities were not preserved");
    assert(persistedTool.notes === "Saved before simulated restart", "Persisted tool notes were not preserved");

    const adapters = await request<Adapter[]>("GET", "/api/adapters");
    const persistedAdapter = adapters.find(adapter => adapter.name === "Persisted Verification SWD Adapter");
    assert(persistedAdapter, "Persisted adapter was not loaded after restart");
    assert(persistedAdapter.category === "Programming Adapter", "Persisted adapter category was not preserved");
    assert(persistedAdapter.manufacturer === "Persistence Labs", "Persisted adapter manufacturer was not preserved");
    assert(persistedAdapter.modelNumber === "SWD-10-6", "Persisted adapter model number was not preserved");
    assert(persistedAdapter.productUrl?.endsWith("/swd-10-6"), "Persisted adapter product URL was not preserved");
    assert(persistedAdapter.imageUrl?.endsWith("/swd-10-6.jpg"), "Persisted adapter image URL was not preserved");
    assert(persistedAdapter.endpointA === "10-pin 1.27 mm Cortex Debug header", "Persisted adapter endpoint A was not preserved");
    assert(persistedAdapter.endpointAType === "debug-header", "Persisted adapter endpoint A type was not preserved");
    assert(persistedAdapter.endpointB === "6-pin 2.54 mm SWD header", "Persisted adapter endpoint B was not preserved");
    assert(persistedAdapter.endpointBType === "pin-header", "Persisted adapter endpoint B type was not preserved");
    assert(persistedAdapter.quantity === 2, "Persisted adapter quantity was not preserved");
    assert(persistedAdapter.location === "Persistence adapter drawer", "Persisted adapter location was not preserved");
    assert(persistedAdapter.compatibility?.includes("1.8-5 V"), "Persisted adapter compatibility was not preserved");
    assert(persistedAdapter.notes === "Saved before simulated restart", "Persisted adapter notes were not preserved");

    const books = await request<ComponentBookWithItems[]>("GET", "/api/component-books");
    const persistedBook = books.find(book => book.name === "Persisted 0805 Book");
    assert(persistedBook, "Persisted component book was not loaded after restart");
    assert(persistedBook.packageSize === "0805", "Persisted component book package size was not preserved");
    assert(persistedBook.items.length === 1, "Persisted component book items were not loaded after restart");
    assert(persistedBook.items[0].value === "4.7 kΩ", "Persisted component book item value was not preserved");

    console.log("Persistence read worker confirmed probe data after restart.");
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
