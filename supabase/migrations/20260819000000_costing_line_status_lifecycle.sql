-- Costing — per-line STATUS LIFECYCLE (Stage A).
--
-- Promotes costing_lines.status from a 2-value manual flag (draft|closed) to a
-- stored, event-driven lifecycle:
--   draft   — new line, nothing sent yet (default)
--   sent    — line is on a published RFQ (vendor has been invited)
--   quoted  — the invited vendor submitted a quote on that RFQ
--   awarded — a vendor quote was selected for the line (selected_vendor_quote_id)
--   lost    — a sibling row (same project + same style) won; this one did not
--   revised — reserved for Stage B (edit-forks-a-Sent-row mechanic) — not yet set
--   closed  — manual terminal close (operator)
--
-- The two-stage Sent -> Quoted split + Lost ("all other same-style rows in the
-- project") are operator decisions. Transitions are written server-side by the
-- RFQ publish / quote-submit / award handlers, each also appending a row to
-- costing_line_status_history. Terminal states (awarded/lost/closed) are never
-- downgraded back to sent/quoted.

-- ─── 1. Expand the status CHECK to the 7 lifecycle values ──────────────────
ALTER TABLE costing_lines
  DROP CONSTRAINT IF EXISTS costing_lines_status_check;

ALTER TABLE costing_lines
  ADD CONSTRAINT costing_lines_status_check
  CHECK (status IN ('draft','sent','quoted','awarded','lost','revised','closed'));

COMMENT ON COLUMN costing_lines.status IS 'Stored per-line lifecycle status: draft, sent, quoted, awarded, lost, revised, closed. Event-driven (sent/quoted/awarded/lost) is written by the RFQ publish/submit/award handlers; draft/closed are operator-settable. revised is reserved for Stage B. Terminal states (awarded/lost/closed) are never downgraded.';

-- ─── 2. Status history table (audit trail; service-role write only) ────────
CREATE TABLE IF NOT EXISTS costing_line_status_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  costing_line_id uuid NOT NULL REFERENCES costing_lines(id) ON DELETE CASCADE,
  status          text NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  changed_by      text,
  note            text
);

CREATE INDEX IF NOT EXISTS idx_costing_line_status_history_line_at
  ON costing_line_status_history (costing_line_id, changed_at);

COMMENT ON TABLE costing_line_status_history IS 'Append-only audit trail of costing_lines.status transitions. Written by the server-side RFQ publish/submit/award handlers (service-role). RLS is enabled with NO policies so only service_role can read or write.';

-- RLS on, no policies → service_role only (matches the costing server-write
-- pattern; the browser never touches this table).
ALTER TABLE costing_line_status_history ENABLE ROW LEVEL SECURITY;

-- ─── 3. Backfill existing lines to their event-derived lifecycle status ────
-- Only touch rows still at the legacy 'draft'; leave any 'closed' alone.
--   awarded — selected_vendor_quote_id IS NOT NULL
--   sent    — else, the line is on a published RFQ (rfq_line_items ->
--             rfqs that already have an invitation row)
--   draft   — else (left as-is)

WITH published_lines AS (
  SELECT DISTINCT rli.costing_line_id
  FROM rfq_line_items rli
  JOIN rfq_invitations inv ON inv.rfq_id = rli.rfq_id
  WHERE rli.costing_line_id IS NOT NULL
)
UPDATE costing_lines cl
SET status = CASE
               WHEN cl.selected_vendor_quote_id IS NOT NULL THEN 'awarded'
               WHEN cl.id IN (SELECT costing_line_id FROM published_lines) THEN 'sent'
               ELSE cl.status
             END
WHERE cl.status = 'draft'
  AND (
    cl.selected_vendor_quote_id IS NOT NULL
    OR cl.id IN (SELECT costing_line_id FROM published_lines)
  );

-- Seed one history row per line that we just moved off draft, stamped at the
-- line's updated_at so the trail has a defensible origin timestamp.
INSERT INTO costing_line_status_history (costing_line_id, status, changed_at, changed_by, note)
SELECT cl.id, cl.status, cl.updated_at, 'system', 'backfill'
FROM costing_lines cl
WHERE cl.status IN ('sent','awarded')
  AND NOT EXISTS (
    SELECT 1 FROM costing_line_status_history h
    WHERE h.costing_line_id = cl.id
  );

-- ─── 4. PostgREST schema reload ────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
