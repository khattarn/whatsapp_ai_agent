-- ============================================================
-- Migration v8: Multi-channel inbox (Instagram + Facebook)
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Add channel column to conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'instagram', 'facebook'));

-- 2. Add channel_user_id to contacts (Instagram/FB use PSIDs, not phones)
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel_user_id TEXT;

-- Allow phone to be NULL for Instagram/Facebook contacts (PSID-only)
ALTER TABLE contacts
  ALTER COLUMN phone DROP NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_channel_user_id_business_idx
  ON contacts (channel_user_id, business_id);

-- 3. Add Instagram/Facebook identifiers to businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS ig_account_id TEXT,
  ADD COLUMN IF NOT EXISTS fb_page_id    TEXT,
  ADD COLUMN IF NOT EXISTS fb_page_token TEXT;

-- 4. Add channel to messages (for per-channel reporting)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'instagram', 'facebook'));
