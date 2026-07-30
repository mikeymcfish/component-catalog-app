import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  Box3,
  BoxGeometry,
  Group,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Texture,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  applyCaseModelUnitScale,
  componentModelRotationQuaternion,
  computeComponentPlacement,
  createComponentPlacementMatrix,
  deriveCalibrationAnchors,
  extractNamedCompartmentAnchors,
  getComponentScaleWarning,
  mapValidatedInstanceGrid,
  type CompartmentAnchor,
  type LogicalCompartment,
} from "../client/src/lib/case-3d-scene/geometry";
import {
  rotateComponentModelQuarterTurn,
  ZERO_COMPONENT_MODEL_QUARTER_TURNS,
  type ComponentModelRotation,
} from "../shared/component-model-rotation";
import type { CaseModelCalibration } from "../shared/model-calibration";
import type { CaseWithCompartments } from "../shared/schema";
import {
  mapWithConcurrency,
  PromiseAssetCache,
} from "../client/src/lib/case-3d-scene/async-pool";
import { createCompartmentNumberLabels } from "../client/src/lib/case-3d-scene/compartment-labels";
import {
  cloneRepresentativeCaseMaterial,
  DEFAULT_CASE_OPEN_ANGLE_RADIANS,
  layoutOpenCaseAssembly,
  type CaseAssemblyHalf,
} from "../client/src/lib/case-3d-scene/assembly";
import {
  caseSceneModelUrlKey,
  resolveAvailableCaseLayer,
  resolveCompartmentSceneLayer,
} from "../client/src/lib/case-3d-scene/model-set";

function near(actual: number, expected: number, message: string, epsilon = 1e-9) {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

function compartments(rows: number, cols: number): LogicalCompartment[] {
  const result: LogicalCompartment[] = [];
  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      result.push({
        id: (row - 1) * cols + col,
        position: `${String.fromCharCode(64 + row)}${col}`,
        row,
        col,
        layer: "top",
      });
    }
  }
  return result;
}

function caseWith(
  logical: LogicalCompartment[],
  overrides: Partial<CaseWithCompartments> = {},
): CaseWithCompartments {
  return {
    id: 1,
    name: "Geometry test",
    model: "CUSTOM-3x2-TOP",
    rows: 2,
    cols: 3,
    hasBottom: false,
    description: null,
    closedImageUrl: null,
    openImageUrl: null,
    topModel3dUrl: `/uploads/models/${"a".repeat(64)}.glb`,
    topModel3dName: "test",
    topModel3dSource: "upload",
    topModel3dCalibration: null,
    bottomModel3dUrl: null,
    bottomModel3dName: null,
    bottomModel3dSource: null,
    bottomModel3dCalibration: null,
    layoutGeometry: null,
    sortOrder: 0,
    isActive: true,
    compartments: logical.map(compartment => ({ caseId: 1, ...compartment })),
    ...overrides,
  };
}

function marker(name: string, x: number, y: number) {
  const result = new Object3D();
  result.name = name;
  result.position.set(x, y, 0);
  return result;
}

function assemblyHalf(
  layer: "top" | "bottom",
  size: [number, number, number],
): CaseAssemblyHalf {
  const root = new Group();
  root.name = `${layer}-fixture`;
  root.add(new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()));
  const content = new Group();
  const pivot = new Group();
  content.add(root);
  pivot.add(content);
  return { layer, root, content, pivot };
}

async function loadGlb(filename: string) {
  const file = fs.readFileSync(path.join(process.cwd(), "default-cases", filename));
  const data = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  return new Promise<Group>((resolve, reject) => {
    new GLTFLoader().parse(data, "", gltf => resolve(gltf.scene), reject);
  });
}

{
  const top = assemblyHalf("top", [0.1, 0.06, 0.015]);
  const bottom = assemblyHalf("bottom", [0.12, 0.08, 0.02]);
  const topMaterial = new MeshStandardMaterial({ color: "#2563eb", roughness: 0.2 });
  const unusedBottomMaterial = new MeshBasicMaterial({ color: "#ffffff" });
  const accessoryMaterial = new MeshStandardMaterial({ color: "#facc15", roughness: 0.4 });
  const bottomTexture = new Texture();
  const bottomMaterial = new MeshStandardMaterial({
    color: "#dc2626",
    roughness: 0.73,
    metalness: 0.14,
    map: bottomTexture,
  });
  (top.root.children[0] as Mesh).material = topMaterial;
  const bottomMesh = bottom.root.children[0] as Mesh;
  bottomMesh.material = [unusedBottomMaterial, accessoryMaterial, bottomMaterial];
  bottomMesh.geometry.clearGroups();
  bottomMesh.geometry.addGroup(0, 3, 1);
  bottomMesh.geometry.addGroup(3, bottomMesh.geometry.index!.count - 3, 2);

  const hingeMaterial = cloneRepresentativeCaseMaterial([top, bottom]);
  assert(hingeMaterial instanceof MeshStandardMaterial, "Hinge should clone the case material type");
  assert.notEqual(hingeMaterial, bottomMaterial, "Hinge material must be independently owned");
  assert(hingeMaterial.color.equals(bottomMaterial.color), "Hinge should prefer the bottom case color");
  assert(
    !hingeMaterial.color.equals(accessoryMaterial.color),
    "A small rendered accessory should not override the dominant case body",
  );
  near(hingeMaterial.roughness, bottomMaterial.roughness, "Hinge case roughness");
  near(hingeMaterial.metalness, bottomMaterial.metalness, "Hinge case metalness");
  assert.equal(hingeMaterial.map, bottomTexture, "Hinge clone should preserve the case texture");

  let sourceDisposeEvents = 0;
  bottomMaterial.addEventListener("dispose", () => { sourceDisposeEvents += 1; });
  hingeMaterial.dispose();
  assert.equal(sourceDisposeEvents, 0, "Disposing the hinge must not dispose its cached source material");
  assert.equal(
    cloneRepresentativeCaseMaterial([{ layer: "bottom", root: new Group() }]),
    null,
    "A material-free case should use the neutral hinge fallback",
  );
}

{
  const bottomRoot = new Group();
  const accessoryMaterial = new MeshStandardMaterial({ color: "#f97316" });
  const instancedBodyMaterial = new MeshStandardMaterial({ color: "#0f766e" });
  bottomRoot.add(new Mesh(new BoxGeometry(1, 1, 1), accessoryMaterial));
  bottomRoot.add(new InstancedMesh(
    new BoxGeometry(0.1, 0.1, 0.1),
    instancedBodyMaterial,
    100,
  ));
  const representative = cloneRepresentativeCaseMaterial([{ layer: "bottom", root: bottomRoot }]);
  assert(representative instanceof MeshStandardMaterial);
  assert(
    representative.color.equals(instancedBodyMaterial.color),
    "One hundred rendered body instances should outweigh one accessory mesh",
  );
  representative.dispose();

  const zeroInstanceRoot = new Group();
  const zeroInstanceMaterial = new MeshStandardMaterial({ color: "#7c3aed" });
  const visibleAccessoryMaterial = new MeshStandardMaterial({ color: "#0284c7" });
  zeroInstanceRoot.add(new InstancedMesh(
    new BoxGeometry(10, 10, 10),
    zeroInstanceMaterial,
    0,
  ));
  zeroInstanceRoot.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), visibleAccessoryMaterial));
  const zeroRepresentative = cloneRepresentativeCaseMaterial([{
    layer: "bottom",
    root: zeroInstanceRoot,
  }]);
  assert(zeroRepresentative instanceof MeshStandardMaterial);
  assert(
    zeroRepresentative.color.equals(visibleAccessoryMaterial.color),
    "A zero-instance mesh must contribute no rendered material weight",
  );
  zeroRepresentative.dispose();
}

{
  const malformedBottom = new Group();
  const bottomMetadataOnly = new MeshStandardMaterial({ color: "#be123c" });
  const malformedMesh = new Mesh(
    new BoxGeometry(1, 1, 1),
    [bottomMetadataOnly],
  );
  malformedMesh.geometry.clearGroups();
  malformedBottom.add(malformedMesh);

  const renderedTop = new Group();
  const renderedTopMaterial = new MeshStandardMaterial({ color: "#16a34a" });
  renderedTop.add(new Mesh(new BoxGeometry(1, 1, 1), renderedTopMaterial));
  const representative = cloneRepresentativeCaseMaterial([
    { layer: "bottom", root: malformedBottom },
    { layer: "top", root: renderedTop },
  ]);
  assert(representative instanceof MeshStandardMaterial);
  assert(
    representative.color.equals(renderedTopMaterial.color),
    "Rendered top evidence should beat unrendered bottom metadata fallback",
  );
  representative.dispose();
}

{
  const bottomOnly = [{ layer: "bottom", url: "/models/bottom.glb" }] as const;
  assert.equal(
    resolveAvailableCaseLayer(bottomOnly, "top"),
    "bottom",
    "A bottom-only case should normalize a stale top route to bottom",
  );
  assert.equal(
    resolveAvailableCaseLayer(bottomOnly, "bottom"),
    "bottom",
    "An available requested layer should remain selected",
  );
  assert.equal(
    resolveCompartmentSceneLayer("top", "bottom"),
    "top",
    "Clicking an empty top compartment should move a bottom route to top",
  );
  assert.equal(
    resolveCompartmentSceneLayer("bottom", "top"),
    "bottom",
    "Clicking a bottom compartment should move a top route to bottom",
  );
  assert.equal(
    resolveCompartmentSceneLayer(undefined, "bottom"),
    "bottom",
    "Clearing selection should retain the remembered layer",
  );
  const savedModels = [{
    layer: "top" as const,
    url: "/models/top.glb",
    calibration: null,
  }];
  const previewModels = [{
    ...savedModels[0],
    calibration: {
      version: 1 as const,
      assetId: "a".repeat(64),
      metersPerModelUnit: 1,
      origin: { x: 0, y: 0, z: 0 },
      columnAxis: { x: 1, y: 0, z: 0 },
      rowAxis: { x: 0, y: 1, z: 0 },
      outwardNormal: { x: 0, y: 0, z: 1 },
    },
  }];
  assert.equal(
    caseSceneModelUrlKey(savedModels),
    caseSceneModelUrlKey(previewModels),
    "Calibration previews must not change the model identity that owns pick markers",
  );
}

{
  const top = assemblyHalf("top", [0.1, 0.06, 0.015]);
  const bottom = assemblyHalf("bottom", [0.12, 0.08, 0.02]);
  const assembly = new Group();
  assembly.add(top.pivot, bottom.pivot);
  const layout = layoutOpenCaseAssembly([top, bottom]);
  assert(layout.hinge, "Two case halves should produce a fake hinge");
  near(layout.openAngleRadians, DEFAULT_CASE_OPEN_ANGLE_RADIANS, "Flat assembly angle");
  near(layout.hinge.center.x, 0, "Hinge X center");
  near(layout.hinge.center.y, 0, "Hinge Y center");
  assert(layout.hinge.length >= 0.12, "Hinge should span the wider case half");
  assert(bottom.pivot.quaternion.equals(new Quaternion()), "Bottom half should remain flat");
  assert(top.pivot.quaternion.equals(new Quaternion()), "Top half should remain unrotated");

  assembly.updateMatrixWorld(true);
  const topBounds = new Box3().setFromObject(top.root, true);
  const bottomBounds = new Box3().setFromObject(bottom.root, true);
  near(topBounds.getCenter(new Vector3()).x, 0, "Top half X alignment");
  near(bottomBounds.getCenter(new Vector3()).x, 0, "Bottom half X alignment");
  assert(bottomBounds.max.y < 0, "Bottom half should stop in front of the hinge");
  near(topBounds.min.z, bottomBounds.min.z, "Both case halves should share the same base plane");
  near(
    topBounds.min.y - bottomBounds.max.y,
    layout.hinge.radius * 2 * 1.15,
    "The case edges should leave the hinge diameter plus clearance",
  );
  near(layout.hinge.radius, 0.00432, "Hinge radius should be twice the previous radius");

  const anchorNode = marker("BIN_A1", 0, 0.025);
  top.root.add(anchorNode);
  assembly.updateMatrixWorld(true);
  const mapping = extractNamedCompartmentAnchors(top.root, compartments(1, 1));
  const expectedWorld = anchorNode.getWorldPosition(new Vector3());
  const mappedWorld = mapping.anchors.get(1)?.center;
  assert(mappedWorld, "The flat top should retain its compartment anchor");
  near(mappedWorld.x, expectedWorld.x, "Top anchor transformed X");
  near(mappedWorld.y, expectedWorld.y, "Top anchor transformed Y");
  near(mappedWorld.z, expectedWorld.z, "Top anchor transformed Z");
  near(mappedWorld.z, 0.0075, "Top anchor should remain on the flat top half");
}

{
  const onlyHalf = assemblyHalf("bottom", [0.12, 0.08, 0.02]);
  const assembly = new Group();
  assembly.add(onlyHalf.pivot);
  const layout = layoutOpenCaseAssembly([onlyHalf]);
  assert.equal(layout.hinge, null, "A one-model case should not synthesize a disconnected hinge");
  assembly.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(onlyHalf.root, true);
  near(bounds.getCenter(new Vector3()).x, 0, "Single half X center");
  near(bounds.getCenter(new Vector3()).y, 0, "Single half Y center");
  near(bounds.min.z, 0, "Single half should rest on the assembly plane");
}

{
  const root = new Group();
  root.position.set(10, 20, 30);
  root.add(marker("BIN_A1", 1, 2), marker("BIN_A2", 3, 2));
  const mapping = extractNamedCompartmentAnchors(root, compartments(1, 2));
  assert.equal(mapping.status.source, "named-anchors");
  assert.equal(mapping.anchors.size, 2);
  assert.deepEqual(mapping.anchors.get(1)?.center.toArray(), [11, 22, 30]);
  const labels = createCompartmentNumberLabels(
    compartments(1, 2).map(compartment => ({
      id: compartment.id,
      position: compartment.position,
    })),
    mapping.anchors,
  );
  assert(labels, "Empty BIN_* transforms should infer a label footprint from neighbor spacing");
  const labelBounds = new Box3().setFromObject(labels, true);
  assert(
    labelBounds.getSize(new Vector3()).length() > 0,
    "Inferred named-anchor labels should have renderable geometry",
  );
  labels.dispose();
  labels.geometry.dispose();
  const labelMaterial = labels.material;
  if (Array.isArray(labelMaterial)) labelMaterial.forEach(item => item.dispose());
  else labelMaterial.dispose();
}

{
  const singleAnchor: CompartmentAnchor = {
    compartmentId: 1,
    position: "A1",
    center: new Vector3(),
    normal: new Vector3(0, 0, 1),
    bounds: new Box3(new Vector3(), new Vector3()),
  };
  const labels = createCompartmentNumberLabels(
    [{ id: 1, position: "A1" }],
    new Map([[1, singleAnchor]]),
  );
  assert(labels, "A lone point anchor should use the conservative fallback footprint");
  assert(
    new Box3().setFromObject(labels, true).getSize(new Vector3()).length() > 0,
    "A lone point anchor label should have renderable geometry",
  );
  labels.dispose();
  labels.geometry.dispose();
  const material = labels.material;
  if (Array.isArray(material)) material.forEach(item => item.dispose());
  else material.dispose();
}

for (const [filename, rows, cols] of [
  ["all-small.glb", 6, 12],
  ["mixed.glb", 4, 6],
  ["variant.glb", 4, 6],
] as const) {
  const scene = await loadGlb(filename);
  const logical = compartments(rows, cols);
  const mapping = mapValidatedInstanceGrid(scene, logical);
  assert.equal(mapping.anchors.size, logical.length, `${filename} should map every real bin instance`);
  assert.equal(mapping.status.source, "instance-grid");
}

{
  const root = new Group();
  const logical = compartments(2, 2);
  for (const [x, y] of [[0, 0], [1, 0], [0, -1], [1, -1]]) {
    const instance = new Group();
    instance.name = "occurrence bin";
    instance.position.set(x, y, 0);
    const body = new Mesh(new BoxGeometry(0.8, 0.8, 0.4), new MeshBasicMaterial());
    body.position.z = -0.2;
    instance.add(body);
    root.add(instance);
  }
  const mapping = mapValidatedInstanceGrid(root, logical);
  assert.equal(mapping.status.source, "instance-grid");
  assert.deepEqual(mapping.anchors.get(1)?.center.toArray(), [0, 0, 0]);
  assert.deepEqual(mapping.anchors.get(4)?.center.toArray(), [1, -1, 0]);

  const extra = new Group();
  extra.name = "occurrence extra";
  extra.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  root.add(extra);
  const rejected = mapValidatedInstanceGrid(root, logical);
  assert.equal(rejected.status.source, "unavailable");
  assert.equal(rejected.anchors.size, 0);
}

{
  const logical = compartments(2, 3);
  const case_ = caseWith(logical, {
    layoutGeometry: {
      version: 1,
      units: 10_000,
      layers: {
        top: {
          rowHeights: [2_000, 8_000],
          columnWidthsByRow: [
            [1_000, 3_000, 6_000],
            [4_000, 2_000, 4_000],
          ],
        },
      },
    },
  });
  const calibration: CaseModelCalibration = {
    version: 1,
    assetId: "a".repeat(64),
    metersPerModelUnit: 0.001,
    origin: { x: 0, y: 0, z: 0 },
    columnAxis: { x: 100, y: 0, z: 0 },
    rowAxis: { x: 0, y: -50, z: 0 },
    outwardNormal: { x: 0, y: 0, z: 1 },
    rimOffset: 2,
    anchorOverrides: { B2: { x: 40, y: -40, z: 10 } },
  };
  const root = new Group();
  applyCaseModelUnitScale(root, calibration);
  applyCaseModelUnitScale(root, calibration);
  near(root.scale.x, 0.001, "Unit scaling must be idempotent");

  const mapping = deriveCalibrationAnchors({ root, case_, layer: "top", calibration });
  near(mapping.anchors.get(1)!.center.x, 0, "A1 x");
  near(mapping.anchors.get(2)!.center.x, (20 / 65) * 0.1, "Nonuniform A2 x");
  near(mapping.anchors.get(3)!.center.x, 0.1, "A3 x");
  near(mapping.anchors.get(4)!.center.y, -0.05, "B1 y");
  near(mapping.anchors.get(6)!.center.x, 0.1, "Per-row normalized B3 x");
  near(mapping.anchors.get(5)!.center.x, 0.04, "Override x");
  near(mapping.anchors.get(5)!.center.y, -0.04, "Override y");
  near(mapping.anchors.get(5)!.center.z, 0.012, "Global rim offset remains additive to overrides");

  const singleLogical = compartments(1, 1);
  const single = deriveCalibrationAnchors({
    root,
    case_: caseWith(singleLogical, { model: "CUSTOM-1x1-TOP", rows: 1, cols: 1 }),
    layer: "top",
    calibration,
  });
  assert.equal(single.anchors.size, 1);
  assert(single.anchors.get(1)!.bounds.getSize(new Vector3()).length() > 0);
}

{
  const component = new Mesh(
    new BoxGeometry(0.01, 0.02, 0.004),
    new MeshBasicMaterial(),
  );
  component.rotation.z = Math.PI / 6;
  component.scale.set(1.2, 0.8, 1.5);
  const originalScale = component.scale.clone();
  const originalQuaternion = component.quaternion.clone();
  const anchor: CompartmentAnchor = {
    compartmentId: 1,
    position: "A1",
    center: new Vector3(1, 2, 3),
    normal: new Vector3(0, 0, 1),
    bounds: new Box3(
      new Vector3(0.994, 1.994, 3),
      new Vector3(1.006, 2.006, 3),
    ),
  };
  const placement = computeComponentPlacement(component, anchor);
  assert.equal(placement.uniformScale, 1, "Actual-size placement must not rescale the model");
  near(placement.placedBounds.min.z, 3.003, "Placed component gap");
  near(placement.placedBounds.getCenter(new Vector3()).x, 1, "Placed x center");
  near(placement.placedBounds.getCenter(new Vector3()).y, 2, "Placed y center");
  assert(component.scale.equals(originalScale), "Placement must preserve scale");
  assert(component.quaternion.equals(originalQuaternion), "Placement must preserve orientation");
  assert(placement.warning, "Oversize component should produce a warning");

  const roomyAnchor = { ...anchor, bounds: new Box3(
    new Vector3(0.9, 1.9, 3),
    new Vector3(1.1, 2.1, 3),
  ) };
  assert.equal(getComponentScaleWarning(placement.placedBounds, roomyAnchor), undefined);

  const implausiblyTiny = new Box3(new Vector3(), new Vector3(1e-7, 1e-7, 1e-7));
  assert.match(
    getComponentScaleWarning(implausiblyTiny, roomyAnchor) || "",
    /implausible/,
    "Physically implausible authored scale should be flagged without resizing",
  );
}

{
  const tiltedSurfaceRotation = new Quaternion().setFromAxisAngle(
    new Vector3(1, 0, 0),
    MathUtils.degToRad(37),
  );
  const tiltedSurfaceNormal = new Vector3(0, 0, 1)
    .applyQuaternion(tiltedSurfaceRotation)
    .normalize();
  const anchor: CompartmentAnchor = {
    compartmentId: 41,
    position: "D5",
    center: new Vector3(0.03, 0.08, 0.06),
    normal: tiltedSurfaceNormal,
    bounds: new Box3(
      new Vector3(0.02, 0.07, 0.05),
      new Vector3(0.04, 0.09, 0.07),
    ),
  };
  const component = new Mesh(
    new BoxGeometry(0.012, 0.008, 0.003),
    new MeshBasicMaterial(),
  );
  const placement = computeComponentPlacement(component, anchor);
  const placedUp = new Vector3(0, 0, 1).applyQuaternion(placement.rotation);
  near(
    placedUp.dot(tiltedSurfaceNormal),
    1,
    "A component should inherit an arbitrary tilted surface normal",
  );
  const lowestSupport = Math.min(
    ...[
      new Vector3(placement.placedBounds.min.x, placement.placedBounds.min.y, placement.placedBounds.min.z),
      new Vector3(placement.placedBounds.min.x, placement.placedBounds.min.y, placement.placedBounds.max.z),
      new Vector3(placement.placedBounds.min.x, placement.placedBounds.max.y, placement.placedBounds.min.z),
      new Vector3(placement.placedBounds.min.x, placement.placedBounds.max.y, placement.placedBounds.max.z),
      new Vector3(placement.placedBounds.max.x, placement.placedBounds.min.y, placement.placedBounds.min.z),
      new Vector3(placement.placedBounds.max.x, placement.placedBounds.min.y, placement.placedBounds.max.z),
      new Vector3(placement.placedBounds.max.x, placement.placedBounds.max.y, placement.placedBounds.min.z),
      new Vector3(placement.placedBounds.max.x, placement.placedBounds.max.y, placement.placedBounds.max.z),
    ].map(corner => corner.dot(tiltedSurfaceNormal)),
  );
  near(
    lowestSupport,
    anchor.center.dot(tiltedSurfaceNormal) + 0.003,
    "Tilted component support gap",
  );

  const correction = componentModelRotationQuaternion({
    version: 1,
    assetId: "a".repeat(64),
    xQuarterTurns: 1,
    yQuarterTurns: 0,
    zQuarterTurns: 1,
  });
  const correctedPlacement = computeComponentPlacement(
    component,
    anchor,
    0.003,
    { mode: "actual" },
    correction,
  );
  const expectedRotation = new Quaternion()
    .setFromUnitVectors(new Vector3(0, 0, 1), tiltedSurfaceNormal)
    .multiply(correction);
  near(
    Math.abs(correctedPlacement.rotation.dot(expectedRotation)),
    1,
    "Saved correction should compose inside the surface-aligned frame",
  );
  component.geometry.dispose();
  component.material.dispose();
}

{
  const anchor: CompartmentAnchor = {
    compartmentId: 1,
    position: "A1",
    center: new Vector3(0, 0, 0),
    normal: new Vector3(0, 0, 1),
    bounds: new Box3(
      new Vector3(-0.01, -0.01, 0),
      new Vector3(0.01, 0.01, 0),
    ),
  };
  const labels = createCompartmentNumberLabels(
    [{ id: 1, position: "A1" }],
    new Map([[1, anchor]]),
    1,
  );
  assert(labels, "A mapped compartment should produce a 3D number label");
  assert(labels.count > 0 && labels.count < 100, "Labels should use a compact pixel instance count");
  const bounds = new Box3().setFromObject(labels, true);
  assert(bounds.min.x >= anchor.bounds.min.x && bounds.max.x <= anchor.bounds.max.x);
  assert(bounds.min.y >= anchor.bounds.min.y && bounds.max.y <= anchor.bounds.max.y);
  assert(
    bounds.getCenter(new Vector3()).y < anchor.center.y,
    "The compartment number should be an in-plane caption below the component",
  );
  const sampleComponent = new Mesh(
    new BoxGeometry(0.01, 0.01, 0.002),
    new MeshBasicMaterial(),
  );
  const componentPlacement = computeComponentPlacement(sampleComponent, anchor);
  assert(
    bounds.max.y < componentPlacement.placedBounds.min.y,
    "The caption should clear a centered component footprint",
  );
  assert(bounds.min.z > anchor.center.z, "Label geometry should sit above the case rim plane");
  sampleComponent.geometry.dispose();
  sampleComponent.material.dispose();
  labels.dispose();
  labels.geometry.dispose();
  const material = labels.material;
  if (Array.isArray(material)) material.forEach(item => item.dispose());
  else material.dispose();
}

{
  const bottomAnchor: CompartmentAnchor = {
    compartmentId: 2,
    position: "B2",
    center: new Vector3(0, 0, 0),
    normal: new Vector3(0, 0, -1),
    bounds: new Box3(
      new Vector3(-0.01, -0.01, 0),
      new Vector3(0.01, 0.01, 0),
    ),
  };
  const labels = createCompartmentNumberLabels(
    [{ id: 2, position: "B2" }],
    new Map([[2, bottomAnchor]]),
  );
  assert(labels, "A bottom compartment should produce a 3D number label");
  const firstMatrix = new Matrix4();
  labels.getMatrixAt(0, firstMatrix);
  const rotation = new Quaternion();
  firstMatrix.decompose(new Vector3(), rotation, new Vector3());
  const labelUp = new Vector3(0, 1, 0).applyQuaternion(rotation);
  assert(labelUp.dot(new Vector3(0, 1, 0)) > 0.99, "Bottom labels should remain upright");
  const bounds = new Box3().setFromObject(labels, true);
  assert(bounds.max.z < bottomAnchor.center.z, "Bottom labels should face outward below the rim plane");
  labels.dispose();
  labels.geometry.dispose();
  const material = labels.material;
  if (Array.isArray(material)) material.forEach(item => item.dispose());
  else material.dispose();
}

{
  const component = new Group();
  component.position.set(0.006, -0.004, 0.002);
  const body = new Mesh(
    new BoxGeometry(0.012, 0.006, 0.003),
    new MeshBasicMaterial(),
  );
  body.position.set(0.003, 0.001, 0.002);
  body.rotation.set(0.2, -0.15, Math.PI / 5);
  body.scale.set(1.4, 0.75, 1.1);
  component.add(body);
  component.updateWorldMatrix(true, true);

  const originalPosition = component.position.clone();
  const originalScale = component.scale.clone();
  const originalQuaternion = component.quaternion.clone();
  const sourceBounds = new Box3().setFromObject(component, true);
  const anchor: CompartmentAnchor = {
    compartmentId: 2,
    position: "A2",
    center: new Vector3(0.05, -0.02, 0.01),
    normal: new Vector3(0, 0, 1),
    bounds: new Box3(
      new Vector3(0.025, -0.045, 0.01),
      new Vector3(0.075, 0.005, 0.01),
    ),
  };

  const displayPlacement = computeComponentPlacement(
    component,
    anchor,
    0.003,
    { mode: "display", targetLargestDimensionMeters: 0.01 },
  );
  const displaySize = displayPlacement.placedBounds.getSize(new Vector3());
  near(
    Math.max(displaySize.x, displaySize.y, displaySize.z),
    0.01,
    "Display mode longest edge",
  );
  near(displayPlacement.placedBounds.min.z, 0.013, "Display mode support gap");
  assert(component.position.equals(originalPosition), "Display placement must not mutate position");
  assert(component.scale.equals(originalScale), "Display placement must not mutate source scale");
  assert(component.quaternion.equals(originalQuaternion), "Display placement must preserve orientation");

  const transformedBounds = sourceBounds
    .clone()
    .applyMatrix4(createComponentPlacementMatrix(displayPlacement));
  near(transformedBounds.min.x, displayPlacement.placedBounds.min.x, "Display matrix min x");
  near(transformedBounds.min.y, displayPlacement.placedBounds.min.y, "Display matrix min y");
  near(transformedBounds.min.z, displayPlacement.placedBounds.min.z, "Display matrix min z");
  near(transformedBounds.max.x, displayPlacement.placedBounds.max.x, "Display matrix max x");
  near(transformedBounds.max.y, displayPlacement.placedBounds.max.y, "Display matrix max y");
  near(transformedBounds.max.z, displayPlacement.placedBounds.max.z, "Display matrix max z");

  const largerDisplayPlacement = computeComponentPlacement(
    component,
    anchor,
    0.003,
    { mode: "display", targetLargestDimensionMeters: 0.025 },
  );
  const largerSize = largerDisplayPlacement.placedBounds.getSize(new Vector3());
  near(
    Math.max(largerSize.x, largerSize.y, largerSize.z),
    0.025,
    "Custom display mode longest edge",
  );
  near(largerDisplayPlacement.placedBounds.min.z, 0.013, "Custom display support gap");

  assert.throws(
    () => computeComponentPlacement(component, anchor, 0.003, {
      mode: "display",
      targetLargestDimensionMeters: 0,
    }),
    /positive finite/,
  );
  assert.throws(
    () => computeComponentPlacement(component, anchor, 0.003, {
      mode: "display",
      targetLargestDimensionMeters: Number.NaN,
    }),
    /positive finite/,
  );
  assert.throws(
    () => computeComponentPlacement(new Group(), anchor),
    /finite renderable bounds/,
  );
}

{
  const component = new Group();
  const body = new Mesh(
    new BoxGeometry(0.018, 0.009, 0.004),
    new MeshBasicMaterial(),
  );
  body.position.set(0.006, -0.002, 0.003);
  component.add(body);
  component.updateWorldMatrix(true, true);
  const sourceBounds = new Box3().setFromObject(component, true);
  const sourceQuaternion = component.quaternion.clone();
  const anchor: CompartmentAnchor = {
    compartmentId: 3,
    position: "A3",
    center: new Vector3(0.1, 0.2, 0.04),
    normal: new Vector3(0, 0, 1),
    bounds: new Box3(
      new Vector3(0.075, 0.175, 0.04),
      new Vector3(0.125, 0.225, 0.04),
    ),
  };
  const rotations: ComponentModelRotation[] = [
    { version: 1, assetId: "a".repeat(64), xQuarterTurns: 1, yQuarterTurns: 0, zQuarterTurns: 0 },
    { version: 1, assetId: "a".repeat(64), xQuarterTurns: 0, yQuarterTurns: 1, zQuarterTurns: 0 },
    { version: 1, assetId: "a".repeat(64), xQuarterTurns: 0, yQuarterTurns: 0, zQuarterTurns: 1 },
    { version: 1, assetId: "a".repeat(64), xQuarterTurns: 1, yQuarterTurns: 2, zQuarterTurns: 3 },
  ];

  rotations.forEach((rotation, index) => {
    const placement = computeComponentPlacement(
      component,
      anchor,
      0.003,
      { mode: "display", targetLargestDimensionMeters: 0.01 },
      componentModelRotationQuaternion(rotation),
    );
    const size = placement.placedBounds.getSize(new Vector3());
    near(Math.max(size.x, size.y, size.z), 0.01, `Rotated display size ${index}`);
    near(placement.placedBounds.min.z, 0.043, `Rotated support gap ${index}`);

    const matrixBounds = sourceBounds
      .clone()
      .applyMatrix4(createComponentPlacementMatrix(placement));
    near(matrixBounds.min.x, placement.placedBounds.min.x, `Rotated matrix min x ${index}`);
    near(matrixBounds.min.y, placement.placedBounds.min.y, `Rotated matrix min y ${index}`);
    near(matrixBounds.min.z, placement.placedBounds.min.z, `Rotated matrix min z ${index}`);
    near(matrixBounds.max.x, placement.placedBounds.max.x, `Rotated matrix max x ${index}`);
    near(matrixBounds.max.y, placement.placedBounds.max.y, `Rotated matrix max y ${index}`);
    near(matrixBounds.max.z, placement.placedBounds.max.z, `Rotated matrix max z ${index}`);
  });
  assert(component.quaternion.equals(sourceQuaternion), "Saved rotation must not mutate the cached model root");

  let turns = { ...ZERO_COMPONENT_MODEL_QUARTER_TURNS };
  for (let index = 0; index < 4; index += 1) {
    turns = rotateComponentModelQuarterTurn(turns, "x");
  }
  assert.deepEqual(turns, ZERO_COMPONENT_MODEL_QUARTER_TURNS, "Four 90-degree clicks should return to zero");
}

{
  let activeLoads = 0;
  let maximumActiveLoads = 0;
  const results = await mapWithConcurrency(
    Array.from({ length: 12 }, (_value, index) => index),
    4,
    async value => {
      activeLoads += 1;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      await new Promise(resolve => setTimeout(resolve, 1));
      activeLoads -= 1;
      return value * 2;
    },
  );
  assert(maximumActiveLoads <= 4, "Progressive GLB work must never exceed four concurrent loads");
  assert.deepEqual(results, Array.from({ length: 12 }, (_value, index) => index * 2));

  let cacheLoads = 0;
  const cache = new PromiseAssetCache(async (url: string) => {
    cacheLoads += 1;
    return { url };
  });
  const [first, second] = await Promise.all([cache.load("same.glb"), cache.load("same.glb")]);
  assert.equal(cacheLoads, 1, "Repeated component GLBs should share one cached load");
  assert.equal(first, second, "Repeated component GLBs should reuse the cached asset object");
}

{
  const startedAt = performance.now();
  const root = new Group();
  const sharedBinGeometry = new BoxGeometry(0.018, 0.018, 0.012);
  const sharedBinMaterial = new MeshBasicMaterial();
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      const instance = new Group();
      instance.name = "occurrence performance bin";
      instance.position.set(col * 0.02, -row * 0.02, 0);
      const body = new Mesh(sharedBinGeometry, sharedBinMaterial);
      body.position.z = -0.006;
      instance.add(body);
      root.add(instance);
    }
  }
  const mapping = mapValidatedInstanceGrid(root, compartments(12, 12));
  assert.equal(mapping.anchors.size, 144, "144-bin performance fixture should map completely");

  const component = new Mesh(new BoxGeometry(0.004, 0.003, 0.001), new MeshBasicMaterial());
  for (const anchor of Array.from(mapping.anchors.values()).slice(0, 40)) {
    computeComponentPlacement(component, anchor);
  }
  assert(
    performance.now() - startedAt < 2_000,
    "144 bins with 40 modeled components should remain an interactive-scale workload",
  );
}

console.log("Case 3D geometry verification passed.");
