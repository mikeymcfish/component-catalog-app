import { z } from "zod";
import { getManagedModelAssetId } from "./model-calibration";

export const quarterTurnSchema = z.number().int().min(0).max(3);

export const componentModelRotationSchema = z.object({
  version: z.literal(1),
  assetId: z.string().regex(/^[a-f0-9]{64}$/),
  xQuarterTurns: quarterTurnSchema,
  yQuarterTurns: quarterTurnSchema,
  zQuarterTurns: quarterTurnSchema,
}).strict();

export type ComponentModelRotation = z.infer<typeof componentModelRotationSchema>;
export type ComponentModelQuarterTurns = Pick<
  ComponentModelRotation,
  "xQuarterTurns" | "yQuarterTurns" | "zQuarterTurns"
>;
export type ComponentModelRotationAxis = "x" | "y" | "z";

export const ZERO_COMPONENT_MODEL_QUARTER_TURNS: ComponentModelQuarterTurns = Object.freeze({
  xQuarterTurns: 0,
  yQuarterTurns: 0,
  zQuarterTurns: 0,
});

export function getComponentModelQuarterTurns(
  rotation: ComponentModelRotation | null | undefined,
): ComponentModelQuarterTurns {
  if (!rotation) return { ...ZERO_COMPONENT_MODEL_QUARTER_TURNS };
  return {
    xQuarterTurns: rotation.xQuarterTurns,
    yQuarterTurns: rotation.yQuarterTurns,
    zQuarterTurns: rotation.zQuarterTurns,
  };
}

export function rotateComponentModelQuarterTurn(
  rotation: ComponentModelQuarterTurns,
  axis: ComponentModelRotationAxis,
): ComponentModelQuarterTurns {
  const key = axis === "x"
    ? "xQuarterTurns"
    : axis === "y" ? "yQuarterTurns" : "zQuarterTurns";
  return {
    ...rotation,
    [key]: ((rotation[key] + 1) % 4) as 0 | 1 | 2 | 3,
  };
}

export function createComponentModelRotation(
  assetId: string,
  rotation: ComponentModelQuarterTurns,
): ComponentModelRotation | null {
  if (
    rotation.xQuarterTurns === 0 &&
    rotation.yQuarterTurns === 0 &&
    rotation.zQuarterTurns === 0
  ) {
    return null;
  }
  return componentModelRotationSchema.parse({ version: 1, assetId, ...rotation });
}

export function parseComponentModelRotationForModel(
  value: unknown,
  modelUrl: string | null | undefined,
): ComponentModelRotation | null {
  const assetId = getManagedModelAssetId(modelUrl);
  if (!assetId || value === null || value === undefined) return null;
  const parsed = componentModelRotationSchema.safeParse(value);
  return parsed.success && parsed.data.assetId === assetId ? parsed.data : null;
}
