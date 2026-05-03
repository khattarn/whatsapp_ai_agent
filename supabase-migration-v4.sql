-- ================================================================
-- Migration v4: Payment Integration (PayU + UPI)
-- Run this in Supabase → SQL Editor
-- ================================================================

-- Add payment credentials to businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS upi_id             TEXT,          -- e.g. business@payu or business@okaxis
  ADD COLUMN IF NOT EXISTS payu_merchant_key  TEXT,          -- PayU Merchant Key (from PayU dashboard)
  ADD COLUMN IF NOT EXISTS payu_merchant_salt TEXT,          -- PayU Salt (from PayU dashboard)
  ADD COLUMN IF NOT EXISTS payu_is_test       BOOLEAN DEFAULT false; -- true = test env, false = production

-- Add per-product payment URL (overrides business-level payment)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS payment_url TEXT;  -- optional direct payment/order link per product

-- Payment links tracking table
CREATE TABLE IF NOT EXISTS payment_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  product_id       UUID REFERENCES products(id) ON DELETE SET NULL,
  amount           DECIMAL(10,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  description      TEXT,
  method           TEXT NOT NULL DEFAULT 'both',  -- 'upi', 'payu', 'both'
  txn_id           TEXT,                           -- unique transaction ID sent to PayU
  payu_link_id     TEXT,                           -- PayU's link ID from response
  payu_short_url   TEXT,                           -- PayU's shareable short URL
  upi_string       TEXT,                           -- UPI deep link string
  status           TEXT NOT NULL DEFAULT 'created', -- created | paid | expired | cancelled
  sent_at          TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_links_business_id     ON payment_links(business_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_conversation_id ON payment_links(conversation_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_status          ON payment_links(status);
