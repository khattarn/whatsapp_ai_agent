-- ================================================
-- Migration v6: Assets storage bucket + template notifications
-- Run in Supabase SQL Editor
-- ================================================

-- Public storage bucket for media assets (images, videos, documents)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'assets',
  'assets',
  TRUE,
  10485760,  -- 10 MB per file
  ARRAY['image/jpeg','image/jpg','image/png','image/gif','image/webp','video/mp4','application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Allow service role full access to assets bucket
DO $$
BEGIN
  CREATE POLICY "Service role full access on assets"
    ON storage.objects FOR ALL
    USING (bucket_id = 'assets');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- ================================================
-- Template status notifications
-- Populated by the webhook when Meta sends
-- message_template_status_update events
-- ================================================
CREATE TABLE IF NOT EXISTS template_notifications (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id  TEXT NOT NULL,
  template_name TEXT NOT NULL,
  language     TEXT,
  event        TEXT NOT NULL,   -- APPROVED | REJECTED | PAUSED | FLAGGED
  reason       TEXT,
  seen         BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_template_notifications_seen
  ON template_notifications(seen, created_at DESC);
