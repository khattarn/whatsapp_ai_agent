-- ================================================================
-- Migration v2: Enhanced Broadcasts (templates, images, videos)
-- Run this in Supabase → SQL Editor
-- ================================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS message_type    TEXT DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS template_name   TEXT,
  ADD COLUMN IF NOT EXISTS template_language TEXT DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS template_variables JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS media_url       TEXT,
  ADD COLUMN IF NOT EXISTS media_type      TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS media_caption   TEXT;

-- Add unique constraint on contacts(phone, business_id) if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_phone_business_id_key'
  ) THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_phone_business_id_key UNIQUE (phone, business_id);
  END IF;
END $$;
