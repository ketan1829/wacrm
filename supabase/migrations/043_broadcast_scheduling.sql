-- ============================================================
-- 043_broadcast_scheduling
--
-- Broadcast V1.1 Scheduling & Persistent Draft Support:
--
--   1. broadcasts.timezone — User-selected timezone (e.g. 'Asia/Kolkata',
--      'America/New_York', 'UTC') for the scheduled broadcast. Allows
--      proper display and editing across different client timezones.
--
--   2. broadcasts.header_media_url — URL for media-header templates
--      (image/video/document) stored alongside draft / scheduled sends
--      so server-side delivery can reconstruct the media component.
--
--   3. Partial index idx_broadcasts_scheduled — Enables fast, efficient
--      cron sweeps for due scheduled broadcasts (WHERE status = 'scheduled').
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;

COMMENT ON COLUMN broadcasts.timezone IS
  'IANA timezone name selected by the user when scheduling the broadcast.';

COMMENT ON COLUMN broadcasts.header_media_url IS
  'Media URL for media-header templates (image/video/document), preserved for server-side scheduled delivery.';

CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled
  ON broadcasts(status, scheduled_at)
  WHERE status = 'scheduled';
