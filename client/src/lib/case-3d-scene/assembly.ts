import {
  Box3,
  Group,
  InstancedMesh,
  Material,
  Mesh,
  Object3D,
  Vector3,
} from "three";
import type { CaseSceneLayer } from "./types";

/** A loaded case half wrapped in a pivot and a translation-only content group. */
export interface CaseAssemblyHalf {
  layer: CaseSceneLayer;
  pivot: Group;
  content: Group;
  root: Object3D;
}

export interface CaseAssemblyHinge {
  center: Vector3;
  length: number;
  radius: number;
}

export interface CaseAssemblyLayout {
  hinge: CaseAssemblyHinge | null;
  openAngleRadians: number;
}

/** Both open case halves are displayed flat in the same assembly plane. */
export const DEFAULT_CASE_OPEN_ANGLE_RADIANS = 0;

function isUsableCaseMaterial(material: Material | undefined): material is Material {
  return Boolean(
    material
    && material.visible
    && (!material.transparent || material.opacity > 0),
  );
}

function renderedElementRange(
  mesh: Mesh,
): { start: number; end: number } | null {
  const geometry = mesh.geometry;
  const totalElements = geometry.index?.count
    ?? geometry.getAttribute("position")?.count;
  if (!Number.isFinite(totalElements) || !totalElements || totalElements <= 0) return null;

  const drawStart = Number.isFinite(geometry.drawRange.start)
    ? Math.max(0, Math.floor(geometry.drawRange.start))
    : 0;
  const requestedCount = geometry.drawRange.count;
  const drawEnd = Number.isFinite(requestedCount)
    ? Math.min(totalElements, drawStart + Math.max(0, Math.floor(requestedCount)))
    : totalElements;
  if (drawEnd <= drawStart) return null;
  return { start: drawStart, end: drawEnd };
}

function renderedMaterialContributions(mesh: Mesh) {
  const range = renderedElementRange(mesh);
  if (!range) return [];
  const instanceMultiplier = mesh instanceof InstancedMesh
    ? Number.isFinite(mesh.count) && mesh.count >= 0
      ? mesh.count
      : 0
    : 1;
  if (instanceMultiplier === 0) return [];
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const contributions: Array<{ material: Material; elements: number }> = [];

  // For a single-material Mesh, Three renders that material across the full
  // draw range regardless of any groups retained on the geometry.
  if (!Array.isArray(mesh.material)) {
    if (isUsableCaseMaterial(mesh.material)) {
      contributions.push({
        material: mesh.material,
        elements: (range.end - range.start) * instanceMultiplier,
      });
    }
    return contributions;
  }

  if (mesh.geometry.groups.length > 0) {
    for (const group of mesh.geometry.groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!isUsableCaseMaterial(material)) continue;
      const groupStart = Number.isFinite(group.start) ? Math.max(0, Math.floor(group.start)) : 0;
      const groupEnd = Number.isFinite(group.count)
        ? groupStart + Math.max(0, Math.floor(group.count))
        : range.end;
      const start = Math.max(range.start, groupStart);
      const end = Math.min(range.end, groupEnd);
      if (end > start) contributions.push({
        material,
        elements: (end - start) * instanceMultiplier,
      });
    }
    return contributions;
  }

  // A material array without groups does not expose which slot the author
  // intended, so leave it for the deterministic usable-material fallback.
  return contributions;
}

/**
 * Clones one renderable case material for the independently owned fake hinge.
 * Bottom is preferred because it is the hinge's base, then top. Textures and
 * all material-specific rendering properties are retained by Three's clone;
 * disposing the clone does not dispose or mutate the cached source material.
 */
export function cloneRepresentativeCaseMaterial(
  halves: readonly Pick<CaseAssemblyHalf, "layer" | "root">[],
): Material | null {
  const ordered = [...halves].sort((left, right) => {
    const priority = (layer: CaseSceneLayer) => layer === "bottom" ? 0 : 1;
    return priority(left.layer) - priority(right.layer);
  });

  const analyzed = ordered.map(half => {
    const contributionByMaterial = new Map<Material, { elements: number; order: number }>();
    const fallbackMaterials: Material[] = [];
    let order = 0;
    half.root.traverseVisible(object => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (isUsableCaseMaterial(material) && !fallbackMaterials.includes(material)) {
          fallbackMaterials.push(material);
        }
      }
      for (const contribution of renderedMaterialContributions(object)) {
        const current = contributionByMaterial.get(contribution.material);
        if (current) current.elements += contribution.elements;
        else contributionByMaterial.set(contribution.material, {
          elements: contribution.elements,
          order: order++,
        });
      }
    });
    const rendered = Array.from(contributionByMaterial.entries())
      .sort((left, right) => (
        right[1].elements - left[1].elements
        || left[1].order - right[1].order
      ))[0]?.[0];
    return { rendered, fallback: fallbackMaterials[0] };
  });

  // Prefer actual rendered evidence in layer order. A malformed/un-grouped
  // bottom material array must not beat a material proven to render on top.
  for (const result of analyzed) {
    if (result.rendered) return result.rendered.clone();
  }
  // Only metadata remains: preserve deterministic bottom-then-top fallback.
  for (const result of analyzed) {
    if (result.fallback) return result.fallback.clone();
  }

  return null;
}

function finiteBounds(root: Object3D) {
  root.updateWorldMatrix(true, true);
  const bounds = new Box3().setFromObject(root, true);
  const values = [
    bounds.min.x,
    bounds.min.y,
    bounds.min.z,
    bounds.max.x,
    bounds.max.y,
    bounds.max.z,
  ];
  if (bounds.isEmpty() || values.some(value => !Number.isFinite(value))) {
    throw new Error(`The ${root.name || "case"} model has no finite renderable bounds`);
  }
  return bounds;
}

function resetHalf(half: CaseAssemblyHalf) {
  half.pivot.position.set(0, 0, 0);
  half.pivot.quaternion.identity();
  half.pivot.scale.set(1, 1, 1);
  half.content.position.set(0, 0, 0);
  half.content.quaternion.identity();
  half.content.scale.set(1, 1, 1);
  half.pivot.updateMatrixWorld(true);
}

function centerSingleHalf(half: CaseAssemblyHalf, bounds: Box3) {
  const center = bounds.getCenter(new Vector3());
  half.content.position.set(-center.x, -center.y, -bounds.min.z);
  half.pivot.updateMatrixWorld(true);
}

/**
 * Arranges two independently authored case halves as one open assembly.
 *
 * Both halves rest flat on the same plane, separated edge-to-edge by enough
 * room for the centered hinge plus a small clearance. Because the authored
 * roots remain below their half pivots, every child transform (case mesh,
 * mapped anchor, component, hit target, or label derived from it) sees the
 * exact same assembly translation.
 */
export function layoutOpenCaseAssembly(
  halves: readonly CaseAssemblyHalf[],
): CaseAssemblyLayout {
  const byLayer = new Map(halves.map(half => [half.layer, half]));
  const top = byLayer.get("top");
  const bottom = byLayer.get("bottom");
  for (const half of halves) resetHalf(half);

  if (!top || !bottom) {
    const onlyHalf = top ?? bottom;
    if (onlyHalf) centerSingleHalf(onlyHalf, finiteBounds(onlyHalf.root));
    return { hinge: null, openAngleRadians: DEFAULT_CASE_OPEN_ANGLE_RADIANS };
  }

  const topBounds = finiteBounds(top.root);
  const bottomBounds = finiteBounds(bottom.root);
  const topSize = topBounds.getSize(new Vector3());
  const bottomSize = bottomBounds.getSize(new Vector3());
  const width = Math.max(topSize.x, bottomSize.x);
  const depth = Math.max(topSize.y, bottomSize.y);
  const characteristicSize = Math.max(width, depth, 0.001);
  // Twice the original 1.8%-of-case radius (including its minimum), yielding
  // a hinge cylinder whose diameter is exactly twice the previous diameter.
  const radius = Math.max(characteristicSize * 0.018, 0.0008) * 2;
  const clearance = radius * 1.15;
  const bottomHeight = Math.max(bottomSize.z, radius * 2);
  const hingeZ = Math.max(radius, Math.min(bottomHeight * 0.42, radius * 2.5));
  const hingeLength = Math.max(width * 1.04, radius * 6);

  const topCenter = topBounds.getCenter(new Vector3());
  const bottomCenter = bottomBounds.getCenter(new Vector3());

  // The bottom's near hinge edge is its maximum Y edge. It remains flat.
  bottom.content.position.set(
    -bottomCenter.x,
    -clearance - bottomBounds.max.y,
    -bottomBounds.min.z,
  );

  // The top's bottom/hinge-facing edge is its minimum Y edge. Position it
  // after the bottom's maximum Y edge, leaving the hinge diameter plus 15%
  // total clearance between the two case edges.
  top.content.position.set(
    -topCenter.x,
    clearance - topBounds.min.y,
    -topBounds.min.z,
  );

  bottom.pivot.updateMatrixWorld(true);
  top.pivot.updateMatrixWorld(true);

  return {
    hinge: {
      center: new Vector3(0, 0, hingeZ),
      length: hingeLength,
      radius,
    },
    openAngleRadians: DEFAULT_CASE_OPEN_ANGLE_RADIANS,
  };
}
