import type {
  CaseInventorySceneModel,
  CaseSceneLayer,
} from "./types";

type CaseSceneModelIdentity = Pick<CaseInventorySceneModel, "layer" | "url">;

/** Uses the requested half when present, otherwise the only/first available half. */
export function resolveAvailableCaseLayer(
  models: readonly CaseSceneModelIdentity[],
  requestedLayer: CaseSceneLayer,
) {
  return models.some(model => model.layer === requestedLayer)
    ? requestedLayer
    : models[0]?.layer ?? requestedLayer;
}

/** Uses an explicitly clicked compartment layer, including empty top cells. */
export function resolveCompartmentSceneLayer(
  compartmentLayer: string | null | undefined,
  fallbackLayer: CaseSceneLayer,
): CaseSceneLayer {
  if (compartmentLayer === "bottom") return "bottom";
  if (compartmentLayer === "top") return "top";
  return fallbackLayer;
}

/**
 * Identity for changes that replace model assets, intentionally excluding
 * calibration previews so in-progress pick markers remain intact.
 */
export function caseSceneModelUrlKey(models: readonly CaseSceneModelIdentity[]) {
  return models
    .map(model => `${model.layer}:${model.url}`)
    .sort()
    .join("|");
}
