CREATE TABLE IF NOT EXISTS "tools" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "category" text NOT NULL,
  "manufacturer" text,
  "model_number" text,
  "quantity" integer NOT NULL DEFAULT 1 CHECK ("quantity" >= 1),
  "location" text,
  "capabilities" text,
  "notes" text
);
