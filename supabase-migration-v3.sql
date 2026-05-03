-- ================================================================
-- Migration v3: Product Catalogue
-- Run this in Supabase → SQL Editor
-- ================================================================

CREATE TABLE IF NOT EXISTS products (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'Other',
  description      TEXT,
  price            DECIMAL(10,2),
  currency         TEXT NOT NULL DEFAULT 'INR',
  sizes            TEXT[] DEFAULT '{}',
  colors           TEXT[] DEFAULT '{}',
  image_url        TEXT,
  product_url      TEXT,
  sku              TEXT,
  in_stock         BOOLEAN NOT NULL DEFAULT true,
  meta_product_id  TEXT,   -- WhatsApp Commerce Manager product retailer ID (set later)
  tags             TEXT[] DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_products_category     ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_in_stock     ON products(in_stock);
CREATE INDEX IF NOT EXISTS idx_products_sku          ON products(sku);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Optional: add system_prompt column to businesses if not present
-- (used by the AI to know how to behave for each business)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS system_prompt TEXT;
