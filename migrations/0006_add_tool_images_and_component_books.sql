ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "product_url" text;
ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "image_url" text;

CREATE TABLE IF NOT EXISTS "component_books" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "manufacturer" text,
  "package_size" text,
  "product_url" text,
  "image_url" text,
  "description" text,
  "notes" text
);

CREATE TABLE IF NOT EXISTS "component_book_items" (
  "id" serial PRIMARY KEY,
  "book_id" integer NOT NULL REFERENCES "component_books"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "category" text,
  "part_number" text,
  "value" text,
  "package_size" text,
  "quantity" integer CHECK ("quantity" IS NULL OR "quantity" >= 0),
  "notes" text
);

CREATE INDEX IF NOT EXISTS "component_book_items_book_id_idx"
  ON "component_book_items" ("book_id");
