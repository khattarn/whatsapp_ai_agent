-- ================================================
-- Migration v10: Broadcast recipient engagement tracking
-- Run in Supabase → SQL Editor
-- ================================================

-- Delivery, read, and button-click timestamps captured via the webhook
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS delivered_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS click_payload  TEXT;

-- Fast lookup by WAMID so the webhook can update a row without scanning the whole table
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_meta_message_id
  ON broadcast_recipients(meta_message_id)
  WHERE meta_message_id IS NOT NULL;
