ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "top_model_3d_calibration" jsonb;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "bottom_model_3d_calibration" jsonb;
