import {
  Box3,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Object3D,
  Euler,
  Quaternion,
  Vector3,
} from "three";
import {
  caseModelCalibrationSchema,
  getManagedModelAssetId,
  type CaseModelCalibration,
} from "@shared/model-calibration";
import {
  CUSTOM_CASE_LAYOUT_UNITS,
  safeParseCustomCaseLayout,
  type CustomCaseLayerGeometry,
} from "@shared/custom-case-layout";
import type { CaseWithCompartments, Compartment } from "@shared/schema";
import type {
  CaseSceneLayer,
  CaseSceneMappingSource,
  CaseSceneMappingStatus,
} from "./types";
import type { ComponentModelRotation } from "@shared/component-model-rotation";

export type LogicalCompartment = Pick<
  Compartment,
  "id" | "position" | "row" | "col" | "layer"
>;

export interface CompartmentAnchor {
  compartmentId: number;
  position: string;
  /** Rim center in world coordinates. */
  center: Vector3;
  /** Unit outward direction in world coordinates. */
  normal: Vector3;
  /** World-axis-aligned compartment footprint/body bounds. */
  bounds: Box3;
  sourceNode?: Object3D;
}

export interface CompartmentAnchorMapping {
  anchors: Map<number, CompartmentAnchor>;
  status: CaseSceneMappingStatus;
}

export interface MapCaseCompartmentAnchorsOptions {
  root: Object3D;
  case_: CaseWithCompartments;
  layer: CaseSceneLayer;
  calibration?: CaseModelCalibration | null;
}

export interface InstanceGridMappingOptions {
  columnOrder?: "ascending" | "descending";
  rowOrder?: "ascending" | "descending";
  clusterTolerance?: number;
}

export interface CalibrationAnchorOptions {
  root: Object3D;
  case_: CaseWithCompartments;
  layer: CaseSceneLayer;
  calibration: CaseModelCalibration;
  compartments?: readonly LogicalCompartment[];
}

export interface ComponentPlacement {
  /** World-space delta applied after the uniform presentation scale. */
  translation: Vector3;
  /** Uniform scale applied around the component scene's world origin. */
  uniformScale: number;
  /** Saved correction applied before authored model transforms. */
  rotation: Quaternion;
  placedBounds: Box3;
  warning?: string;
}

export type ComponentScalePolicy =
  | { mode: "actual" }
  | { mode: "display"; targetLargestDimensionMeters: number };

const baseScaleByRoot = new WeakMap<Object3D, Vector3>();
const namedAnchorPattern = /^BIN_(.+)$/i;
const localUp = new Vector3(0, 0, 1);

function createStatus(
  source: CaseSceneMappingSource,
  compartments: readonly LogicalCompartment[],
  anchors: ReadonlyMap<number, CompartmentAnchor>,
  message?: string,
): CaseSceneMappingStatus {
  return {
    source,
    mappedCount: anchors.size,
    expectedCount: compartments.length,
    missingPositions: compartments
      .filter(compartment => !anchors.has(compartment.id))
      .map(compartment => compartment.position),
    ...(message ? { message } : {}),
  };
}

function unavailable(
  compartments: readonly LogicalCompartment[],
  message: string,
): CompartmentAnchorMapping {
  const anchors = new Map<number, CompartmentAnchor>();
  return { anchors, status: createStatus("unavailable", compartments, anchors, message) };
}

function unitWorldNormal(node: Object3D, localNormal = localUp) {
  node.updateWorldMatrix(true, false);
  return localNormal.clone()
    .applyMatrix3(new Matrix3().getNormalMatrix(node.matrixWorld))
    .normalize();
}

function pointBounds(point: Vector3) {
  return new Box3(point.clone(), point.clone());
}

function sourceBounds(node: Object3D, root: Object3D, center: Vector3) {
  const bounds = new Box3().setFromObject(node, true);
  if (!bounds.isEmpty() && bounds.getSize(new Vector3()).lengthSq() > 0) return bounds;

  if (node.parent && node.parent !== root) {
    const parentBounds = new Box3().setFromObject(node.parent, true);
    if (!parentBounds.isEmpty() && parentBounds.getSize(new Vector3()).lengthSq() > 0) {
      return parentBounds;
    }
  }
  return pointBounds(center);
}

/** Idempotently applies the model-unit conversion to the visible case root. */
export function applyCaseModelUnitScale(
  root: Object3D,
  calibration: Pick<CaseModelCalibration, "metersPerModelUnit"> | null | undefined,
) {
  let baseScale = baseScaleByRoot.get(root);
  if (!baseScale) {
    baseScale = root.scale.clone();
    baseScaleByRoot.set(root, baseScale);
  }

  root.scale.copy(baseScale).multiplyScalar(calibration?.metersPerModelUnit ?? 1);
  root.updateMatrixWorld(true);
  return root;
}

/** Finds exact `BIN_<position>` markers and returns them in world space. */
export function extractNamedCompartmentAnchors(
  root: Object3D,
  compartments: readonly LogicalCompartment[],
): CompartmentAnchorMapping {
  root.updateMatrixWorld(true);
  const compartmentsByPosition = new Map(
    compartments.map(compartment => [compartment.position.toUpperCase(), compartment]),
  );
  const anchors = new Map<number, CompartmentAnchor>();
  const duplicatePositions = new Set<string>();

  root.traverse(node => {
    const match = namedAnchorPattern.exec(node.name.trim());
    if (!match) return;
    const position = match[1].toUpperCase();
    const compartment = compartmentsByPosition.get(position);
    if (!compartment) return;
    if (anchors.has(compartment.id)) {
      duplicatePositions.add(compartment.position);
      anchors.delete(compartment.id);
      return;
    }

    const center = node.getWorldPosition(new Vector3());
    anchors.set(compartment.id, {
      compartmentId: compartment.id,
      position: compartment.position,
      center,
      normal: unitWorldNormal(node),
      bounds: sourceBounds(node, root, center),
      sourceNode: node,
    });
  });

  const message = duplicatePositions.size > 0
    ? `Duplicate named anchors: ${Array.from(duplicatePositions).join(", ")}`
    : anchors.size === compartments.length
      ? undefined
      : "Named BIN_<position> anchors are incomplete";
  return {
    anchors,
    status: createStatus("named-anchors", compartments, anchors, message),
  };
}

interface InstanceCandidate {
  localCenter: Vector3;
  worldCenter: Vector3;
  bounds: Box3;
  sourceNode: Object3D;
}

interface CoordinateCluster {
  center: number;
  memberIndexes: number[];
}

function isMeshNode(node: Object3D) {
  return Boolean((node as Object3D & { isMesh?: boolean }).isMesh);
}

function nestedMetadataMarksInstance(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/entity.?type/i.test(key) && typeof nested === "string" && nested.toLowerCase() === "instance") {
      return true;
    }
    if (nestedMetadataMarksInstance(nested, depth + 1)) return true;
  }
  return false;
}

function isInstanceGroup(node: Object3D) {
  return /^(?:occurrence|instance)(?:[\s_-]|$)/i.test(node.name.trim()) ||
    nestedMetadataMarksInstance(node.userData);
}

function descendantMeshCount(node: Object3D) {
  let count = 0;
  node.traverse(child => {
    if (child !== node && isMeshNode(child) && !(child instanceof InstancedMesh)) count += 1;
  });
  return count;
}

function boxCorners(box: Box3) {
  return [
    new Vector3(box.min.x, box.min.y, box.min.z),
    new Vector3(box.min.x, box.min.y, box.max.z),
    new Vector3(box.min.x, box.max.y, box.min.z),
    new Vector3(box.min.x, box.max.y, box.max.z),
    new Vector3(box.max.x, box.min.y, box.min.z),
    new Vector3(box.max.x, box.min.y, box.max.z),
    new Vector3(box.max.x, box.max.y, box.min.z),
    new Vector3(box.max.x, box.max.y, box.max.z),
  ];
}

function transformedBox(box: Box3, matrix: Matrix4) {
  return new Box3().setFromPoints(boxCorners(box).map(corner => corner.applyMatrix4(matrix)));
}

function candidateFromNode(root: Object3D, node: Object3D): InstanceCandidate {
  const worldCenter = node.getWorldPosition(new Vector3());
  return {
    localCenter: root.worldToLocal(worldCenter.clone()),
    worldCenter,
    bounds: sourceBounds(node, root, worldCenter),
    sourceNode: node,
  };
}

function collectInstanceCandidates(root: Object3D, expectedCount: number) {
  root.updateMatrixWorld(true);
  const instancedCandidates: InstanceCandidate[] = [];
  const instanceGroups: Object3D[] = [];
  const meshes: Object3D[] = [];
  const instanceMatrix = new Matrix4();

  root.traverse(node => {
    if (node instanceof InstancedMesh) {
      if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
      for (let index = 0; index < node.count; index += 1) {
        node.getMatrixAt(index, instanceMatrix);
        const worldMatrix = new Matrix4().multiplyMatrices(node.matrixWorld, instanceMatrix);
        const worldCenter = new Vector3().setFromMatrixPosition(worldMatrix);
        instancedCandidates.push({
          localCenter: root.worldToLocal(worldCenter.clone()),
          worldCenter,
          bounds: node.geometry.boundingBox
            ? transformedBox(node.geometry.boundingBox, worldMatrix)
            : pointBounds(worldCenter),
          sourceNode: node,
        });
        root.updateMatrixWorld(true);
      }
      return;
    }

    if (isMeshNode(node)) meshes.push(node);
    if (node !== root && isInstanceGroup(node) && descendantMeshCount(node) === 1) {
      instanceGroups.push(node);
    }
  });

  if (instancedCandidates.length === expectedCount) return instancedCandidates;
  if (instanceGroups.length === expectedCount) {
    return instanceGroups.map(node => candidateFromNode(root, node));
  }

  const uniqueParents = Array.from(new Set(meshes.map(mesh => mesh.parent).filter(
    (parent): parent is Object3D => Boolean(parent && parent !== root),
  )));
  if (uniqueParents.length === expectedCount) {
    return uniqueParents.map(node => candidateFromNode(root, node));
  }
  if (meshes.length === expectedCount) return meshes.map(node => candidateFromNode(root, node));
  return null;
}

function coordinate(point: Vector3, axis: number) {
  return axis === 0 ? point.x : axis === 1 ? point.y : point.z;
}

function clusterCoordinates(
  candidates: readonly InstanceCandidate[],
  axis: number,
  tolerance: number,
) {
  const sorted = candidates
    .map((candidate, index) => ({ index, value: coordinate(candidate.localCenter, axis) }))
    .sort((left, right) => left.value - right.value);
  const clusters: CoordinateCluster[] = [];

  for (const item of sorted) {
    const cluster = clusters.at(-1);
    if (!cluster || Math.abs(item.value - cluster.center) > tolerance) {
      clusters.push({ center: item.value, memberIndexes: [item.index] });
      continue;
    }
    cluster.memberIndexes.push(item.index);
    cluster.center = cluster.memberIndexes.reduce(
      (total, index) => total + coordinate(candidates[index].localCenter, axis),
      0,
    ) / cluster.memberIndexes.length;
  }
  return clusters;
}

function automaticClusterTolerance(candidates: readonly InstanceCandidate[]) {
  const bounds = new Box3().setFromPoints(candidates.map(candidate => candidate.localCenter));
  const size = bounds.getSize(new Vector3());
  return Math.max(size.x, size.y, size.z) * 1e-4 + 1e-7;
}

function sortedLogicalCoordinates(
  compartments: readonly LogicalCompartment[],
  key: "row" | "col",
) {
  return Array.from(new Set(compartments.map(compartment => compartment[key]))).sort(
    (left, right) => left - right,
  );
}

/**
 * Maps one physical instance/body per logical cell. It intentionally refuses
 * partial or ambiguous grids: node count, row/column clusters, and every grid
 * intersection must all match the logical layer.
 */
export function mapValidatedInstanceGrid(
  root: Object3D,
  compartments: readonly LogicalCompartment[],
  options: InstanceGridMappingOptions = {},
): CompartmentAnchorMapping {
  const logicalRows = sortedLogicalCoordinates(compartments, "row");
  const logicalCols = sortedLogicalCoordinates(compartments, "col");
  if (logicalRows.length * logicalCols.length !== compartments.length) {
    return unavailable(compartments, "Logical compartments do not form a complete rectangular grid");
  }

  const candidates = collectInstanceCandidates(root, compartments.length);
  if (!candidates) {
    return unavailable(compartments, "Case model instance/body count does not match the logical compartment count");
  }
  const tolerance = options.clusterTolerance ?? automaticClusterTolerance(candidates);
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RangeError("Cluster tolerance must be a positive finite number");
  }

  const axisPairs: ReadonlyArray<readonly [number, number]> = [
    [0, 1], [1, 0], [0, 2], [2, 0], [1, 2], [2, 1],
  ];
  for (const [columnAxis, rowAxis] of axisPairs) {
    let columnClusters = clusterCoordinates(candidates, columnAxis, tolerance);
    let rowClusters = clusterCoordinates(candidates, rowAxis, tolerance);
    if (columnClusters.length !== logicalCols.length || rowClusters.length !== logicalRows.length) {
      continue;
    }

    columnClusters = columnClusters.sort((left, right) => left.center - right.center);
    rowClusters = rowClusters.sort((left, right) => left.center - right.center);
    if ((options.columnOrder ?? "ascending") === "descending") columnClusters.reverse();
    if ((options.rowOrder ?? "descending") === "descending") rowClusters.reverse();

    const columnByCandidate = new Map<number, number>();
    const rowByCandidate = new Map<number, number>();
    columnClusters.forEach((cluster, clusterIndex) => {
      cluster.memberIndexes.forEach(candidateIndex => columnByCandidate.set(candidateIndex, clusterIndex));
    });
    rowClusters.forEach((cluster, clusterIndex) => {
      cluster.memberIndexes.forEach(candidateIndex => rowByCandidate.set(candidateIndex, clusterIndex));
    });

    const candidateByGridCell = new Map<string, number>();
    let ambiguous = false;
    candidates.forEach((_candidate, candidateIndex) => {
      const rowIndex = rowByCandidate.get(candidateIndex);
      const columnIndex = columnByCandidate.get(candidateIndex);
      if (rowIndex === undefined || columnIndex === undefined) {
        ambiguous = true;
        return;
      }
      const key = `${rowIndex}:${columnIndex}`;
      if (candidateByGridCell.has(key)) ambiguous = true;
      candidateByGridCell.set(key, candidateIndex);
    });
    if (ambiguous || candidateByGridCell.size !== compartments.length) continue;

    const remainingAxis = [0, 1, 2].find(axis => axis !== columnAxis && axis !== rowAxis)!;
    const localNormal = new Vector3(
      remainingAxis === 0 ? 1 : 0,
      remainingAxis === 1 ? 1 : 0,
      remainingAxis === 2 ? 1 : 0,
    );
    const worldNormal = unitWorldNormal(root, localNormal);
    const anchors = new Map<number, CompartmentAnchor>();
    for (const compartment of compartments) {
      const logicalRowIndex = logicalRows.indexOf(compartment.row);
      const logicalColIndex = logicalCols.indexOf(compartment.col);
      const candidateIndex = candidateByGridCell.get(`${logicalRowIndex}:${logicalColIndex}`);
      if (candidateIndex === undefined) {
        ambiguous = true;
        break;
      }
      const candidate = candidates[candidateIndex];
      anchors.set(compartment.id, {
        compartmentId: compartment.id,
        position: compartment.position,
        center: candidate.worldCenter.clone(),
        normal: worldNormal.clone(),
        bounds: candidate.bounds.clone(),
        sourceNode: candidate.sourceNode,
      });
    }
    if (ambiguous) continue;
    return { anchors, status: createStatus("instance-grid", compartments, anchors) };
  }

  return unavailable(compartments, "Case model row/column clusters do not match the logical grid");
}

interface TrackFraction {
  center: number;
  min: number;
  max: number;
}

function vectorFromRecord(vector: { x: number; y: number; z: number }) {
  return new Vector3(vector.x, vector.y, vector.z);
}

function uniformTrackFraction(index: number, count: number): TrackFraction {
  if (count === 1) return { center: 0, min: -0.5, max: 0.5 };
  const denominator = count - 1;
  return {
    center: index / denominator,
    min: (index - 0.5) / denominator,
    max: (index + 0.5) / denominator,
  };
}

function normalizedTrackFractions(tracks: readonly number[]): TrackFraction[] {
  if (tracks.length === 1) return [{ center: 0, min: -0.5, max: 0.5 }];
  let cursor = 0;
  const raw = tracks.map(track => {
    const min = cursor / CUSTOM_CASE_LAYOUT_UNITS;
    cursor += track;
    const max = cursor / CUSTOM_CASE_LAYOUT_UNITS;
    return { center: (min + max) / 2, min, max };
  });
  const firstCenter = raw[0].center;
  const centerSpan = raw.at(-1)!.center - firstCenter;
  return raw.map(track => ({
    center: (track.center - firstCenter) / centerSpan,
    min: (track.min - firstCenter) / centerSpan,
    max: (track.max - firstCenter) / centerSpan,
  }));
}

function getCustomLayerGeometry(
  case_: CaseWithCompartments,
  layer: CaseSceneLayer,
): CustomCaseLayerGeometry | null {
  if (!case_.model.startsWith("CUSTOM-") || !case_.layoutGeometry) return null;
  const parsed = safeParseCustomCaseLayout(case_.layoutGeometry, {
    rows: case_.rows,
    cols: case_.cols,
    hasBottom: Boolean(case_.hasBottom),
  });
  if (!parsed.success) return null;
  return parsed.data.layers[layer] ?? null;
}

function deriveSingleTrackAxes(
  columnAxis: Vector3,
  rowAxis: Vector3,
  normal: Vector3,
  columnCount: number,
  rowCount: number,
) {
  let effectiveColumn = columnAxis.clone();
  let effectiveRow = rowAxis.clone();
  const defaultMagnitude = Math.max(columnAxis.length(), rowAxis.length(), 1);

  if (columnCount === 1) {
    const magnitude = rowCount > 1 ? rowAxis.length() / (rowCount - 1) : defaultMagnitude;
    effectiveColumn = normal.clone().cross(rowAxis).normalize().multiplyScalar(magnitude);
  }
  if (rowCount === 1) {
    const magnitude = columnCount > 1 ? columnAxis.length() / (columnCount - 1) : defaultMagnitude;
    effectiveRow = effectiveColumn.clone().cross(normal).normalize().multiplyScalar(magnitude);
  }
  return { columnAxis: effectiveColumn, rowAxis: effectiveRow };
}

function calibrationPoint(
  origin: Vector3,
  columnAxis: Vector3,
  rowAxis: Vector3,
  normal: Vector3,
  columnFraction: number,
  rowFraction: number,
  rimOffset: number,
) {
  return origin.clone()
    .addScaledVector(columnAxis, columnFraction)
    .addScaledVector(rowAxis, rowFraction)
    .addScaledVector(normal, rimOffset);
}

/** Builds complete world-space anchors from a valid, asset-bound calibration. */
export function deriveCalibrationAnchors({
  root,
  case_,
  layer,
  calibration,
  compartments = case_.compartments.filter(compartment => compartment.layer === layer),
}: CalibrationAnchorOptions): CompartmentAnchorMapping {
  const parsedCalibration = caseModelCalibrationSchema.safeParse(calibration);
  if (!parsedCalibration.success) {
    return unavailable(compartments, "Case model calibration is invalid");
  }
  if (compartments.length === 0) return unavailable(compartments, "Layer has no compartments");

  const logicalRows = sortedLogicalCoordinates(compartments, "row");
  const logicalCols = sortedLogicalCoordinates(compartments, "col");
  if (logicalRows.length * logicalCols.length !== compartments.length) {
    return unavailable(compartments, "Logical compartments do not form a complete rectangular grid");
  }

  root.updateMatrixWorld(true);
  const value = parsedCalibration.data;
  const origin = vectorFromRecord(value.origin);
  const rawColumnAxis = vectorFromRecord(value.columnAxis);
  const rawRowAxis = vectorFromRecord(value.rowAxis);
  const localNormal = vectorFromRecord(value.outwardNormal).normalize();
  const effectiveAxes = deriveSingleTrackAxes(
    rawColumnAxis,
    rawRowAxis,
    localNormal,
    logicalCols.length,
    logicalRows.length,
  );
  const rimOffset = value.rimOffset ?? 0;
  const customLayer = getCustomLayerGeometry(case_, layer);
  const rowFractions = customLayer
    ? normalizedTrackFractions(customLayer.rowHeights)
    : logicalRows.map((_row, index) => uniformTrackFraction(index, logicalRows.length));
  const columnFractionsByRow = logicalRows.map((_row, rowIndex) => {
    const widths = customLayer?.columnWidthsByRow[rowIndex];
    return widths
      ? normalizedTrackFractions(widths)
      : logicalCols.map((_col, index) => uniformTrackFraction(index, logicalCols.length));
  });
  const overridesByPosition = new Map(
    Object.entries(value.anchorOverrides ?? {}).map(([position, point]) => [
      position.toUpperCase(),
      point,
    ]),
  );
  const worldNormal = unitWorldNormal(root, localNormal);
  const anchors = new Map<number, CompartmentAnchor>();

  for (const compartment of compartments) {
    const rowIndex = logicalRows.indexOf(compartment.row);
    const columnIndex = logicalCols.indexOf(compartment.col);
    const rowFraction = rowFractions[rowIndex];
    const columnFraction = columnFractionsByRow[rowIndex]?.[columnIndex];
    if (!rowFraction || !columnFraction) {
      return unavailable(compartments, "Custom layout dimensions do not match the logical grid");
    }

    const baseLocalCenter = calibrationPoint(
      origin,
      effectiveAxes.columnAxis,
      effectiveAxes.rowAxis,
      localNormal,
      columnFraction.center,
      rowFraction.center,
      rimOffset,
    );
    const override = overridesByPosition.get(compartment.position.toUpperCase());
    const localCenter = override
      ? vectorFromRecord(override).addScaledVector(localNormal, rimOffset)
      : baseLocalCenter;
    const overrideDelta = localCenter.clone().sub(baseLocalCenter);
    const localCorners = [
      [columnFraction.min, rowFraction.min],
      [columnFraction.min, rowFraction.max],
      [columnFraction.max, rowFraction.min],
      [columnFraction.max, rowFraction.max],
    ].map(([column, row]) => calibrationPoint(
      origin,
      effectiveAxes.columnAxis,
      effectiveAxes.rowAxis,
      localNormal,
      column,
      row,
      rimOffset,
    ).add(overrideDelta).applyMatrix4(root.matrixWorld));
    const center = localCenter.clone().applyMatrix4(root.matrixWorld);
    anchors.set(compartment.id, {
      compartmentId: compartment.id,
      position: compartment.position,
      center,
      normal: worldNormal.clone(),
      bounds: new Box3().setFromPoints(localCorners),
    });
  }

  return { anchors, status: createStatus("calibration", compartments, anchors) };
}

/** Resolves the best complete mapping without mixing partially trusted sources. */
export function mapCaseCompartmentAnchors({
  root,
  case_,
  layer,
  calibration,
}: MapCaseCompartmentAnchorsOptions): CompartmentAnchorMapping {
  const compartments = case_.compartments.filter(compartment => compartment.layer === layer);
  if (compartments.length === 0) return unavailable(compartments, "Layer has no compartments");

  const activeModelUrl = layer === "top" ? case_.topModel3dUrl : case_.bottomModel3dUrl;
  const activeAssetId = getManagedModelAssetId(activeModelUrl);
  const parsedCalibration = caseModelCalibrationSchema.safeParse(calibration);
  const activeCalibration = parsedCalibration.success && parsedCalibration.data.assetId === activeAssetId
    ? parsedCalibration.data
    : null;
  applyCaseModelUnitScale(root, activeCalibration);

  const named = extractNamedCompartmentAnchors(root, compartments);
  if (named.anchors.size === compartments.length) return named;

  if (activeCalibration) {
    const calibrated = deriveCalibrationAnchors({
      root,
      case_,
      layer,
      calibration: activeCalibration,
      compartments,
    });
    if (calibrated.anchors.size === compartments.length) return calibrated;
  }

  const instanceGrid = mapValidatedInstanceGrid(root, compartments);
  if (instanceGrid.anchors.size === compartments.length) return instanceGrid;
  const calibrationMessage = calibration && !activeCalibration
    ? "Calibration is invalid or belongs to a different model asset. "
    : "";
  return unavailable(
    compartments,
    `${calibrationMessage}${instanceGrid.status.message ?? "No complete compartment mapping is available"}`,
  );
}

function projectedBoxExtent(box: Box3, axis: Vector3) {
  const size = box.getSize(new Vector3());
  return Math.abs(axis.x) * size.x + Math.abs(axis.y) * size.y + Math.abs(axis.z) * size.z;
}

function tangentAxes(normal: Vector3) {
  const reference = Math.abs(normal.z) < 0.9
    ? new Vector3(0, 0, 1)
    : new Vector3(0, 1, 0);
  const first = reference.cross(normal).normalize();
  const second = normal.clone().cross(first).normalize();
  return [first, second] as const;
}

/** Warns without fitting a component to its compartment. */
export function getComponentScaleWarning(
  componentBounds: Box3,
  anchor: CompartmentAnchor,
  clearanceRatio = 0.9,
  scaleMode: ComponentScalePolicy["mode"] = "actual",
): string | undefined {
  if (!Number.isFinite(clearanceRatio) || clearanceRatio <= 0 || clearanceRatio > 1) {
    throw new RangeError("Clearance ratio must be greater than zero and at most one");
  }
  if (componentBounds.isEmpty() || anchor.bounds.isEmpty()) return undefined;
  const physicalSize = componentBounds.getSize(new Vector3());
  const largestExtent = Math.max(physicalSize.x, physicalSize.y, physicalSize.z);
  if (scaleMode === "actual" && (largestExtent < 0.00001 || largestExtent > 1)) {
    return `Component size (${(largestExtent * 1_000).toPrecision(3)} mm maximum) appears implausible at its authored scale.`;
  }
  const normal = anchor.normal.clone();
  if (normal.lengthSq() === 0) return undefined;
  normal.normalize();
  const [first, second] = tangentAxes(normal);
  const componentExtents = [
    projectedBoxExtent(componentBounds, first),
    projectedBoxExtent(componentBounds, second),
  ];
  const availableExtents = [
    projectedBoxExtent(anchor.bounds, first) * clearanceRatio,
    projectedBoxExtent(anchor.bounds, second) * clearanceRatio,
  ];
  if (availableExtents.some(extent => extent <= 1e-9)) return undefined;
  if (componentExtents.every((extent, index) => extent <= availableExtents[index] + 1e-9)) {
    return undefined;
  }

  const componentMillimeters = componentExtents.map(extent => Math.round(extent * 1_000));
  const availableMillimeters = availableExtents.map(extent => Math.round(extent * 1_000));
  return `Component footprint ${componentMillimeters.join("×")} mm exceeds the ` +
    `${availableMillimeters.join("×")} mm compartment clearance; it was not resized to fit.`;
}

function assertFiniteBounds(bounds: Box3) {
  const values = [
    bounds.min.x,
    bounds.min.y,
    bounds.min.z,
    bounds.max.x,
    bounds.max.y,
    bounds.max.z,
  ];
  if (bounds.isEmpty() || values.some(value => !Number.isFinite(value))) {
    throw new Error("Component model has no finite renderable bounds");
  }
}

export function createComponentPlacementMatrix(placement: ComponentPlacement) {
  return new Matrix4().compose(
    placement.translation,
    placement.rotation,
    new Vector3(
      placement.uniformScale,
      placement.uniformScale,
      placement.uniformScale,
    ),
  );
}

export function componentModelRotationQuaternion(
  rotation: ComponentModelRotation | null | undefined,
) {
  if (!rotation) return new Quaternion();
  return new Quaternion().setFromEuler(new Euler(
    rotation.xQuarterTurns * Math.PI / 2,
    rotation.yQuarterTurns * Math.PI / 2,
    rotation.zQuarterTurns * Math.PI / 2,
    "YXZ",
  ));
}

/**
 * Aligns component-local +Z to the compartment surface normal, then applies
 * the saved model correction in that surface-local frame. The transformed
 * Box3 is centered in the rim plane and its lowest support point lands exactly
 * `gapMeters` along the outward normal. Actual mode returns a scale of 1.
 */
export function computeComponentPlacement(
  object: Object3D,
  anchor: CompartmentAnchor,
  gapMeters = 0.003,
  scalePolicy: ComponentScalePolicy = { mode: "actual" },
  correctionRotation = new Quaternion(),
): ComponentPlacement {
  if (!Number.isFinite(gapMeters) || gapMeters < 0) {
    throw new RangeError("Component gap must be a non-negative finite number");
  }
  object.updateWorldMatrix(true, true);
  const sourceBounds = new Box3().setFromObject(object, true);
  assertFiniteBounds(sourceBounds);
  const correction = correctionRotation.clone();
  if (
    !Number.isFinite(correction.x) ||
    !Number.isFinite(correction.y) ||
    !Number.isFinite(correction.z) ||
    !Number.isFinite(correction.w) ||
    correction.lengthSq() <= 1e-12
  ) {
    throw new Error("Component model rotation is invalid");
  }
  correction.normalize();

  const normal = anchor.normal.clone();
  if (
    !Number.isFinite(normal.x) ||
    !Number.isFinite(normal.y) ||
    !Number.isFinite(normal.z) ||
    normal.lengthSq() === 0
  ) {
    throw new Error("Compartment anchor normal is invalid");
  }
  normal.normalize();
  const surfaceAlignment = new Quaternion().setFromUnitVectors(localUp, normal);
  const rotation = surfaceAlignment.multiply(correction);
  const orientedBounds = sourceBounds
    .clone()
    .applyMatrix4(new Matrix4().makeRotationFromQuaternion(rotation));
  assertFiniteBounds(orientedBounds);

  const sourceSize = orientedBounds.getSize(new Vector3());
  const largestSourceExtent = Math.max(sourceSize.x, sourceSize.y, sourceSize.z);
  if (!Number.isFinite(largestSourceExtent) || largestSourceExtent <= 1e-12) {
    throw new Error("Component model bounds are too small to scale");
  }

  let uniformScale = 1;
  if (scalePolicy.mode === "display") {
    const target = scalePolicy.targetLargestDimensionMeters;
    if (!Number.isFinite(target) || target <= 0) {
      throw new RangeError("Component display size must be a positive finite number");
    }
    uniformScale = target / largestSourceExtent;
    if (!Number.isFinite(uniformScale) || uniformScale <= 0) {
      throw new RangeError("Component display scale is invalid");
    }
  }

  const bounds = new Box3(
    orientedBounds.min.clone().multiplyScalar(uniformScale),
    orientedBounds.max.clone().multiplyScalar(uniformScale),
  );
  assertFiniteBounds(bounds);

  const boundsCenter = bounds.getCenter(new Vector3());
  const centerDelta = anchor.center.clone().sub(boundsCenter);
  const tangentTranslation = centerDelta.clone().addScaledVector(
    normal,
    -centerDelta.dot(normal),
  );
  const lowestProjection = Math.min(...boxCorners(bounds).map(corner => corner.dot(normal)));
  const targetProjection = anchor.center.dot(normal) + gapMeters;
  const translation = tangentTranslation.addScaledVector(
    normal,
    targetProjection - lowestProjection,
  );
  const placedBounds = bounds.clone().translate(translation);
  const warning = getComponentScaleWarning(placedBounds, anchor, 0.9, scalePolicy.mode);
  return { translation, uniformScale, rotation, placedBounds, ...(warning ? { warning } : {}) };
}
