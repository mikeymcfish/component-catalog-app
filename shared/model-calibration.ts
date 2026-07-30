import { z } from "zod";

export const CASE_MODEL_CALIBRATION_VERSION = 1 as const;
export const MODEL_ASSET_ID_PATTERN = /^[a-f0-9]{64}$/;
export const MANAGED_MODEL_URL_PATTERN = /^\/uploads\/models\/([a-f0-9]{64})\.glb$/;

const finiteNumberSchema = z.number().finite();

export const modelVector3Schema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
}).strict();

const nonZeroVector3Schema = modelVector3Schema.refine(
  vector => Math.max(Math.abs(vector.x), Math.abs(vector.y), Math.abs(vector.z)) > 0,
  { message: "Vector must not be zero" },
);

function normalizeVector(vector: z.infer<typeof modelVector3Schema>) {
  const scale = Math.max(Math.abs(vector.x), Math.abs(vector.y), Math.abs(vector.z));
  if (scale === 0) return null;
  const scaled = { x: vector.x / scale, y: vector.y / scale, z: vector.z / scale };
  const length = Math.hypot(scaled.x, scaled.y, scaled.z);
  return { x: scaled.x / length, y: scaled.y / length, z: scaled.z / length };
}

export const caseModelCalibrationSchema = z.object({
  version: z.literal(CASE_MODEL_CALIBRATION_VERSION),
  assetId: z.string().regex(MODEL_ASSET_ID_PATTERN),
  metersPerModelUnit: finiteNumberSchema.positive(),
  origin: modelVector3Schema,
  columnAxis: nonZeroVector3Schema,
  rowAxis: nonZeroVector3Schema,
  outwardNormal: nonZeroVector3Schema,
  rimOffset: finiteNumberSchema.optional(),
  anchorOverrides: z.record(z.string().trim().min(1).max(100), modelVector3Schema).optional(),
}).strict().superRefine((calibration, context) => {
  const column = normalizeVector(calibration.columnAxis);
  const row = normalizeVector(calibration.rowAxis);
  const normal = normalizeVector(calibration.outwardNormal);
  if (!column || !row || !normal) return;
  const cross = {
    x: column.y * row.z - column.z * row.y,
    y: column.z * row.x - column.x * row.z,
    z: column.x * row.y - column.y * row.x,
  };
  const crossLength = Math.hypot(cross.x, cross.y, cross.z);

  if (crossLength <= 1e-6) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rowAxis"],
      message: "Row and column axes must not be parallel",
    });
    return;
  }

  const normalAlignment = Math.abs(
    normal.x * cross.x + normal.y * cross.y + normal.z * cross.z,
  ) / crossLength;
  if (normalAlignment <= 1e-6) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outwardNormal"],
      message: "Outward normal must not lie in the row/column plane",
    });
  }
});

export const deleteCaseModelCalibrationSchema = z.object({
  assetId: z.string().regex(MODEL_ASSET_ID_PATTERN),
}).strict();

export type ModelVector3 = z.infer<typeof modelVector3Schema>;
export type CaseModelCalibration = z.infer<typeof caseModelCalibrationSchema>;

export function getManagedModelAssetId(modelUrl: string | null | undefined) {
  return modelUrl?.match(MANAGED_MODEL_URL_PATTERN)?.[1] ?? null;
}

export function parseCalibrationForModel(
  calibration: unknown,
  modelUrl: string | null | undefined,
): CaseModelCalibration | null {
  const activeAssetId = getManagedModelAssetId(modelUrl);
  if (!activeAssetId) return null;

  const parsed = caseModelCalibrationSchema.safeParse(calibration);
  return parsed.success && parsed.data.assetId === activeAssetId ? parsed.data : null;
}
