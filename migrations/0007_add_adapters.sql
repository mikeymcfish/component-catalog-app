CREATE TABLE IF NOT EXISTS "adapters" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "category" text NOT NULL,
  "manufacturer" text,
  "model_number" text,
  "product_url" text,
  "image_url" text,
  "quantity" integer NOT NULL DEFAULT 1 CHECK ("quantity" >= 1),
  "location" text,
  "compatibility" text,
  "notes" text
);
