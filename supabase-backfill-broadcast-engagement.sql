-- ================================================
-- One-time backfill: sync broadcast_recipients from wa_message_events
-- Run ONCE in Supabase → SQL Editor
-- Safe to re-run (all updates are guarded with IS NULL / status checks)
-- ================================================

-- 1. Stamp delivered_at where Meta confirmed delivery
UPDATE broadcast_recipients br
SET delivered_at = e.timestamp
FROM wa_message_events e
WHERE br.meta_message_id = e.wamid
  AND e.status = 'delivered'
  AND br.delivered_at IS NULL;

-- 2. Stamp read_at where the recipient opened the message
UPDATE broadcast_recipients br
SET read_at = e.timestamp
FROM wa_message_events e
WHERE br.meta_message_id = e.wamid
  AND e.status = 'read'
  AND br.read_at IS NULL;

-- 3. Mark async delivery failures (e.g. number not on WhatsApp, error 131026)
--    Only touches rows still marked 'sent' — won't overwrite already-correct data
UPDATE broadcast_recipients br
SET status        = 'failed',
    error_message = CASE
                      WHEN e.error_code IS NOT NULL
                        THEN e.error_code::text || ': ' || COALESCE(e.error_title, 'delivery failed')
                      ELSE 'delivery failed'
                    END
FROM wa_message_events e
WHERE br.meta_message_id = e.wamid
  AND e.status = 'failed'
  AND br.status = 'sent';

-- 4. Re-tally sent_count and failed_count on all broadcasts from the corrected recipient data
UPDATE broadcasts b
SET sent_count   = sub.sent_count,
    failed_count = sub.failed_count
FROM (
  SELECT broadcast_id,
         COUNT(*) FILTER (WHERE status = 'sent')   AS sent_count,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
  FROM broadcast_recipients
  GROUP BY broadcast_id
) sub
WHERE b.id = sub.broadcast_id;
