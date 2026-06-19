-- ================================================
-- Migration v8: Add error_message to broadcast_recipients
-- Run in Supabase → SQL Editor
-- ================================================

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS error_message TEXT;
