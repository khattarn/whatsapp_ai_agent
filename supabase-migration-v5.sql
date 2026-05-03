-- ================================================================
-- Migration v5: Invoice / Billing Integration
-- Run this in Supabase → SQL Editor
-- ================================================================

-- Add billing details to businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS address   TEXT,          -- full address for invoice header
  ADD COLUMN IF NOT EXISTS gstin     TEXT,          -- GST Identification Number
  ADD COLUMN IF NOT EXISTS logo_url  TEXT;          -- public URL of business logo (for PDF)

-- ----------------------------------------------------------------
-- Invoices table
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id    UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id         UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- Invoice metadata
  invoice_no         TEXT NOT NULL,                 -- e.g. INV-2024-001 or from Busy
  invoice_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date           DATE,

  -- Customer details (snapshot at invoice time)
  customer_name      TEXT,
  customer_phone     TEXT,
  customer_address   TEXT,
  customer_gstin     TEXT,                          -- customer GST number (B2B)

  -- Line items stored as JSON array:
  -- [{ description, hsn, qty, unit, rate, amount, cgst_rate, sgst_rate, igst_rate,
  --    cgst_amount, sgst_amount, igst_amount, total }]
  items              JSONB NOT NULL DEFAULT '[]',

  -- Totals
  subtotal           DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount           DECIMAL(12,2) NOT NULL DEFAULT 0,
  cgst_total         DECIMAL(12,2) NOT NULL DEFAULT 0,
  sgst_total         DECIMAL(12,2) NOT NULL DEFAULT 0,
  igst_total         DECIMAL(12,2) NOT NULL DEFAULT 0,
  grand_total        DECIMAL(12,2) NOT NULL DEFAULT 0,

  -- Source & delivery
  source             TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'busy_csv' | 'excel'
  notes              TEXT,
  pdf_url            TEXT,                           -- Supabase Storage public URL
  status             TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | paid | cancelled
  sent_at            TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_business_id     ON invoices(business_id);
CREATE INDEX IF NOT EXISTS idx_invoices_contact_id      ON invoices(contact_id);
CREATE INDEX IF NOT EXISTS idx_invoices_conversation_id ON invoices(conversation_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status          ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no      ON invoices(invoice_no);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_invoices_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE PROCEDURE update_invoices_updated_at();

-- ----------------------------------------------------------------
-- Supabase Storage bucket for invoice PDFs
-- Run this separately in the Storage section of Supabase dashboard:
--   1. Go to Storage → New bucket
--   2. Name: "invoices"
--   3. Public: YES (so PDF URLs work without auth tokens)
--   4. File size limit: 5 MB
--   5. Allowed MIME types: application/pdf
--
-- Or run via Supabase SQL Editor (requires service_role):
-- ----------------------------------------------------------------

-- Enable storage extension if not already enabled
-- (usually already enabled on hosted Supabase)
-- CREATE EXTENSION IF NOT EXISTS "storage" SCHEMA extensions;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoices',
  'invoices',
  true,
  5242880,   -- 5 MB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Allow public read of invoice PDFs
CREATE POLICY IF NOT EXISTS "Public read invoices"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'invoices');

-- Allow authenticated service role to insert/update/delete
CREATE POLICY IF NOT EXISTS "Service role manage invoices"
  ON storage.objects FOR ALL
  USING (bucket_id = 'invoices');
