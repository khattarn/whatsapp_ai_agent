-- ================================================
-- Migration v7: Add AI settings columns to businesses
-- Run in Supabase SQL Editor if you don't see the
-- Settings tab AI form (system_prompt / AI mode).
-- Safe to run multiple times.
-- ================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS system_prompt TEXT,
  ADD COLUMN IF NOT EXISTS ai_auto_threshold TEXT DEFAULT 'simple'
    CHECK (ai_auto_threshold IN ('all', 'simple', 'none'));
