import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";
import type { CompartmentAnchor } from "./geometry";

export interface CompartmentLabelEntry {
  id: number;
  position: string;
}

interface LabelPixel {
  center: Vector3;
  rotation: Quaternion;
  scale: Vector3;
  selected: boolean;
}

const GLYPH_ROWS = 7;
const GLYPH_COLUMNS = 5;
const GLYPH_GAP = 1;
const MIN_USABLE_EXTENT = 1e-8;
const DEFAULT_SINGLE_ANCHOR_EXTENT = 0.02;
const NEIGHBOR_FOOTPRINT_RATIO = 0.82;

/**
 * A compact 5x7 block font. Each lit pixel becomes a shallow box, making the
 * labels real Three.js geometry without relying on a separately loaded font.
 */
const PIXEL_FONT: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function projectedExtent(size: Vector3, axis: Vector3) {
  return Math.abs(axis.x) * size.x + Math.abs(axis.y) * size.y + Math.abs(axis.z) * size.z;
}

function labelBasis(normalValue: Vector3) {
  const normal = normalValue.clone().normalize();
  // Prefer world-up so text on both +Z and -Z case faces stays upright when
  // viewed from that face. Fall back to world-forward for a vertical surface.
  let up = new Vector3(0, 1, 0).addScaledVector(normal, -normal.y);
  if (up.lengthSq() < 1e-6) {
    up = new Vector3(0, 0, 1).addScaledVector(normal, -normal.z);
  }
  up.normalize();
  const right = up.clone().cross(normal).normalize();
  const rotation = new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(right, up, normal),
  );
  return { normal, right, up, rotation };
}

function normalizedLabel(position: string, compartmentId: number) {
  return (position.trim() || String(compartmentId)).toLocaleUpperCase();
}

function inferredFootprintExtents(
  anchor: CompartmentAnchor,
  anchors: ReadonlyMap<number, CompartmentAnchor>,
  right: Vector3,
  up: Vector3,
) {
  const anchorSize = anchor.bounds.getSize(new Vector3());
  const measuredWidth = projectedExtent(anchorSize, right);
  const measuredHeight = projectedExtent(anchorSize, up);
  let horizontalSpacing = Number.POSITIVE_INFINITY;
  let verticalSpacing = Number.POSITIVE_INFINITY;
  let nearestSpacing = Number.POSITIVE_INFINITY;

  anchors.forEach(candidate => {
    if (candidate.compartmentId === anchor.compartmentId) return;
    const delta = candidate.center.clone().sub(anchor.center);
    const horizontal = Math.abs(delta.dot(right));
    const vertical = Math.abs(delta.dot(up));
    const tangentDistance = Math.hypot(horizontal, vertical);
    if (!Number.isFinite(tangentDistance) || tangentDistance <= MIN_USABLE_EXTENT) return;
    nearestSpacing = Math.min(nearestSpacing, tangentDistance);

    // Prefer a same-row / same-column neighbor. A small tolerance allows for
    // authored-coordinate noise while rejecting diagonals in a regular grid.
    if (
      horizontal > MIN_USABLE_EXTENT &&
      vertical <= Math.max(horizontal * 0.2, MIN_USABLE_EXTENT)
    ) {
      horizontalSpacing = Math.min(horizontalSpacing, horizontal);
    }
    if (
      vertical > MIN_USABLE_EXTENT &&
      horizontal <= Math.max(vertical * 0.2, MIN_USABLE_EXTENT)
    ) {
      verticalSpacing = Math.min(verticalSpacing, vertical);
    }
  });

  const generalFallback = Number.isFinite(nearestSpacing)
    ? nearestSpacing * NEIGHBOR_FOOTPRINT_RATIO
    : DEFAULT_SINGLE_ANCHOR_EXTENT;
  const availableWidth = measuredWidth > MIN_USABLE_EXTENT
    ? measuredWidth
    : Number.isFinite(horizontalSpacing)
      ? horizontalSpacing * NEIGHBOR_FOOTPRINT_RATIO
      : generalFallback;
  const availableHeight = measuredHeight > MIN_USABLE_EXTENT
    ? measuredHeight
    : Number.isFinite(verticalSpacing)
      ? verticalSpacing * NEIGHBOR_FOOTPRINT_RATIO
      : generalFallback;

  return { availableWidth, availableHeight };
}

function createLabelPixels(
  entry: CompartmentLabelEntry,
  anchor: CompartmentAnchor,
  anchors: ReadonlyMap<number, CompartmentAnchor>,
  selected: boolean,
) {
  if (anchor.normal.lengthSq() < 1e-12) return [];

  const label = normalizedLabel(entry.position, entry.id);
  const { normal, right, up, rotation } = labelBasis(anchor.normal);
  const { availableWidth, availableHeight } = inferredFootprintExtents(
    anchor,
    anchors,
    right,
    up,
  );
  const labelWidthUnits = label.length * GLYPH_COLUMNS + Math.max(label.length - 1, 0) * GLYPH_GAP;
  const unit = Math.min(
    (availableWidth * 0.72) / Math.max(labelWidthUnits, 1),
    (availableHeight * 0.22) / GLYPH_ROWS,
  );
  if (!Number.isFinite(unit) || unit <= 1e-8) return [];

  const pixelSize = unit * 0.82;
  const depth = Math.max(Math.min(unit * 0.28, 0.001), Math.min(unit * 0.08, 0.00004));
  const surfaceGap = Math.max(Math.min(unit * 0.08, 0.00015), 0.00001);
  // Use the lower part of the compartment as a caption area. This keeps the
  // number centered beneath the model instead of directly behind its body.
  const base = anchor.center.clone()
    .addScaledVector(up, -availableHeight * 0.36)
    .addScaledVector(normal, depth / 2 + surfaceGap);
  const pixels: LabelPixel[] = [];

  Array.from(label).forEach((character, characterIndex) => {
    const rows = PIXEL_FONT[character] ?? PIXEL_FONT["?"];
    rows.forEach((row, rowIndex) => {
      Array.from(row).forEach((cell, columnIndex) => {
        if (cell !== "1") return;
        const globalColumn = characterIndex * (GLYPH_COLUMNS + GLYPH_GAP) + columnIndex;
        const x = (globalColumn + 0.5 - labelWidthUnits / 2) * unit;
        const y = (GLYPH_ROWS / 2 - rowIndex - 0.5) * unit;
        pixels.push({
          center: base.clone().addScaledVector(right, x).addScaledVector(up, y),
          rotation,
          scale: new Vector3(pixelSize, pixelSize, depth),
          selected,
        });
      });
    });
  });

  return pixels;
}

/**
 * Creates every visible compartment label as one instanced mesh (one draw
 * call), including selection color. The caller owns and must dispose it.
 */
export function createCompartmentNumberLabels(
  entries: readonly CompartmentLabelEntry[],
  anchors: ReadonlyMap<number, CompartmentAnchor>,
  selectedCompartmentId: number | null = null,
) {
  const pixels = entries.flatMap(entry => {
    const anchor = anchors.get(entry.id);
    return anchor
      ? createLabelPixels(entry, anchor, anchors, entry.id === selectedCompartmentId)
      : [];
  });
  if (pixels.length === 0) return null;

  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshBasicMaterial({
    color: "#ffffff",
    toneMapped: false,
  });
  const mesh = new InstancedMesh(geometry, material, pixels.length);
  mesh.name = "compartment-number-labels";
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 4;

  const matrix = new Matrix4();
  pixels.forEach((pixel, index) => {
    matrix.compose(pixel.center, pixel.rotation, pixel.scale);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, new Color(pixel.selected ? "#f0abfc" : "#facc15"));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  return mesh;
}
