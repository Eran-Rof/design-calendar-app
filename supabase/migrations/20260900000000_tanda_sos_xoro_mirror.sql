-- ════════════════════════════════════════════════════════════════════════════
-- tanda_sos — Xoro Sales-Order mirror (the SO counterpart of tanda_pos)
--
-- WHY: there is no rich SO mirror table. The only synced SO data is the gzip
-- ATS blob (app_data['ats_base_data'].sos), which is CSV-derived and LOSSY:
-- style-color SKU grain only (no per-size), no rich Xoro header, no cancel
-- date, and the nightly only fetches Released + Partially Shipped. A faithful
-- native SO import (sales_orders/_lines with real statuses + dates + per-size
-- lines) needs the full Xoro payload, exactly like tanda_pos gives us for POs.
--
-- This table is the missing rich source. It is populated by the server-side
-- endpoint POST /api/tanda/sync-sos-from-xoro (api/_handlers/tanda/
-- sync-sos-from-xoro.js), which fans out salesorder/getsalesorder (ATS-App /
-- "items" credentials), flattens each wrapped { SoEstimateHeader,
-- SoEstimateItemLineArr } record into a flat shape, and upserts here. The
-- native importer (scripts/import-xoro-orders.mjs) then reads tanda_sos into
-- sales_orders/_lines.
--
-- Shape mirrors tanda_pos 1:1 (so_number unique key + hoisted columns + full
-- data jsonb). RLS mirrors tanda_pos: anon (the internal four sub-apps) gets
-- FOR ALL; the table is not vendor-facing so there is no authenticated policy.
--
-- Fully idempotent (CREATE TABLE / POLICY IF NOT EXISTS guards).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tanda_sos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_number     text NOT NULL UNIQUE,               -- Xoro OrderNumber — primary lookup key
  customer      text NOT NULL DEFAULT '',           -- customer name string (free text)
  date_order    date,                               -- header order date (best-effort)
  date_shipped  date,                               -- header DateToBeShipped
  date_cancel   date,                               -- header DateToBeCancelled
  status        text NOT NULL DEFAULT '',           -- Xoro header/line status name
  data          jsonb NOT NULL DEFAULT '{}'::jsonb, -- full flattened Xoro SO payload (+ Items[])
  synced_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tanda_sos IS 'Xoro Sales-Order mirror (SO counterpart of tanda_pos). Read-only feed populated by POST /api/tanda/sync-sos-from-xoro from salesorder/getsalesorder. The data jsonb holds the full flattened Xoro payload (header fields + Items[]); top columns are the most-queried fields hoisted for index-friendliness. Consumed by scripts/import-xoro-orders.mjs to fill native sales_orders/_lines.';

CREATE INDEX IF NOT EXISTS idx_tanda_sos_status ON tanda_sos (status);
CREATE INDEX IF NOT EXISTS idx_tanda_sos_synced_at ON tanda_sos (synced_at DESC);

-- ── RLS (mirror tanda_pos anon-permissive pattern) ──────────────────────────
ALTER TABLE tanda_sos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_tanda_sos" ON tanda_sos;
CREATE POLICY "anon_all_tanda_sos" ON tanda_sos
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
