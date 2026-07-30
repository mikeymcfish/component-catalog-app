ALTER TABLE "adapters"
  ADD COLUMN IF NOT EXISTS "endpoint_a" text,
  ADD COLUMN IF NOT EXISTS "endpoint_a_type" text,
  ADD COLUMN IF NOT EXISTS "endpoint_b" text,
  ADD COLUMN IF NOT EXISTS "endpoint_b_type" text;

-- Backfill the seven adapters bundled with the JSON catalog when those same
-- product records also exist in PostgreSQL. Other adapters remain nullable so
-- older imports and private catalogs are never assigned guessed interfaces.
UPDATE "adapters" SET
  "endpoint_a" = 'TQFP/QFP-48 socket',
  "endpoint_a_type" = 'qfp',
  "endpoint_b" = 'DIP-48 male header',
  "endpoint_b_type" = 'dip'
WHERE "product_url" LIKE '%B077SZZ596%' AND "endpoint_a" IS NULL;

UPDATE "adapters" SET
  "endpoint_a" = 'TQFP/QFP-32 socket',
  "endpoint_a_type" = 'qfp',
  "endpoint_b" = 'DIP-32 male header',
  "endpoint_b_type" = 'dip'
WHERE "product_url" LIKE '%B0H8WTPS25%' AND "endpoint_a" IS NULL;

UPDATE "adapters" SET
  "endpoint_a" = 'SOP-8 / SOP-16 socket',
  "endpoint_a_type" = 'soic',
  "endpoint_b" = 'DIP-8 / DIP-16 male header',
  "endpoint_b_type" = 'dip'
WHERE "product_url" LIKE '%B09Y417816%' AND "endpoint_a" IS NULL;

UPDATE "adapters" SET
  "endpoint_a" = 'QFN-32 5 x 5 mm socket',
  "endpoint_a_type" = 'qfn',
  "endpoint_b" = 'DIP-32 male header',
  "endpoint_b_type" = 'dip'
WHERE "product_url" LIKE '%B00D2PW2OM%' AND "endpoint_a" IS NULL;

UPDATE "adapters" SET
  "endpoint_a" = 'QFN-24 4 x 4 mm socket',
  "endpoint_a_type" = 'qfn',
  "endpoint_b" = 'DIP-24 male header',
  "endpoint_b_type" = 'dip'
WHERE "product_url" LIKE '%B00ENLGNJO%' AND "endpoint_a" IS NULL;

UPDATE "adapters" SET
  "endpoint_a" = 'DB-25 male + female',
  "endpoint_a_type" = 'd-sub',
  "endpoint_b" = '25-position screw terminals',
  "endpoint_b_type" = 'terminal-block'
WHERE "product_url" LIKE '%B0DKSS7PN7%' AND "endpoint_a" IS NULL;

UPDATE "adapters" SET
  "endpoint_a" = 'DE-9 male or female',
  "endpoint_a_type" = 'd-sub',
  "endpoint_b" = '9-position screw terminals',
  "endpoint_b_type" = 'terminal-block'
WHERE "product_url" LIKE '%B073RGGDKH%' AND "endpoint_a" IS NULL;
