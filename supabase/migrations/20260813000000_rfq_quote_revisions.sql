-- 20260813000000_rfq_quote_revisions.sql
--
-- Vendor quote revisions. A vendor may RESUBMIT a revised quote after they've
-- already submitted, while the RFQ is still open. Each time they revise, the
-- CURRENT quote header + lines are snapshotted into rfq_quote_revisions and the
-- live rfq_quotes row is reopened (status back to 'draft', revision bumped) so
-- the vendor can edit + re-submit. The internal review then shows old-vs-new
-- with dates.
--
-- rfq_quotes gains a `revision` counter (starts at 1). rfq_quote_revisions is a
-- service-role-only history table (RLS on, NO policies) — same lockdown pattern
-- as rfq_messages / vendor_invite_tokens. All access flows through the
-- service-role API handlers.

ALTER TABLE rfq_quotes ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS rfq_quote_revisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id      uuid NOT NULL REFERENCES rfq_quotes(id) ON DELETE CASCADE,
  rfq_id        uuid REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id     uuid,
  revision      integer NOT NULL,
  -- The prior quote header + lines:
  --   { total_price, lead_time_days, valid_until, notes,
  --     lines: [{ rfq_line_item_id, unit_price, quantity, notes }] }
  snapshot      jsonb NOT NULL,
  submitted_at  timestamptz,            -- the prior submission's time
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfq_quote_revisions_quote_id ON rfq_quote_revisions (quote_id, revision);

-- Service-role only: RLS on, zero policies. Every read/write goes through the
-- API handlers which authenticate the vendor or gate the internal caller.
ALTER TABLE rfq_quote_revisions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE rfq_quote_revisions IS 'Snapshots of prior vendor quote revisions (header + lines). Service-role only via API handlers; no RLS policies by design.';
COMMENT ON COLUMN rfq_quotes.revision IS 'Vendor quote revision counter, starts at 1; incremented each time the vendor revises a submitted quote.';
