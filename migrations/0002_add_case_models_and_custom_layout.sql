ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "top_model_3d_url" text;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "top_model_3d_name" text;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "top_model_3d_source" text;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "bottom_model_3d_url" text;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "bottom_model_3d_name" text;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "bottom_model_3d_source" text;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "layout_geometry" jsonb;
