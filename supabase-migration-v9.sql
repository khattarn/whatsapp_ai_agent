-- ================================================
-- Migration v9: Scheduled broadcasts
-- Run in Supabase → SQL Editor
-- ================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS template_buttons JSONB;
