-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine T10-1 — Source-tagging columns + xoro_mirror_runs state table
--
-- First chunk of cross-cutter T10 (Shadow Mirror — see
-- docs/tangerine/T10-shadow-mirror-architecture.md).
--
-- Adds `source text NOT NULL DEFAULT 'manual'` with a CHECK enum to every
-- sub-ledger table that gets writes from multiple producers (manual UI +
-- future integrations like xoro_mirror / shopify / fba / etc.).
--
-- Existing rows default to 'manual' — semantically correct since pre-T10
-- everything was operator-typed.
--
-- For `inventory_layers`, the existing `source_kind` column already enums
-- WHY a layer was created (ap_invoice / opening_balance / adjustment /
-- transfer_in / credit_memo_return). T10 reuses it by EXTENDING the
-- enum with a new value `xoro_mirror_snapshot` — keeps semantics clean
-- without adding a second column.
--
-- Plus one new state-tracking table `xoro_mirror_runs` for the nightly
-- mirror cron's idempotency.
--
-- Manual-fallback principle (memory rule, 2026-05-28):
--   every Tangerine module wrapping an external integration MUST also
--   support manual entry. The `source` column makes producer-of-row
--   first-class so UI can show a badge + filter, and so the mirror
--   never overwrites operator-typed rows.
--
-- Fully idempotent (CHECK constraints added via DO $$ guards;
-- IF NOT EXISTS columns; ON CONFLICT NOTHING for table creation).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. `source` enum value set ───────────────────────────────────────────
--
-- Same set across every table that gets one. CHECK constraints are
-- created in DO $$ blocks so re-running this migration is safe.
--
--   manual       — operator typed it in the Tangerine UI
--   xoro_mirror  — T10 nightly mirror created it from Xoro fetch (this chunk's reason)
--   shopify      — P11 future (Shopify webhook / order import)
--   fba          — P12 future (Amazon FBA settlement)
--   walmart      — P12 future (Walmart marketplace settlement)
--   faire        — P12 future (Faire wholesale marketplace)
--   edi_3pl      — P22 future (EDI 856 ASN, 945 ship confirmation, etc.)
--   plaid_sync   — P6 already in use on bank_transactions (added retroactively)
--   api          — external API call to Tangerine (future SaaS)
--   system       — internal trigger / RPC (e.g. trigger-emitted JE)

-- ─── 2. ar_invoices ──────────────────────────────────────────────────────
ALTER TABLE ar_invoices
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ar_invoices_source_check'
  ) THEN
    ALTER TABLE ar_invoices
      ADD CONSTRAINT ar_invoices_source_check
        CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ar_invoices_source ON ar_invoices (source);

COMMENT ON COLUMN ar_invoices.source IS 'T10 source-tagging: who/what produced this row. UI shows as a badge; T10 mirror never touches non-xoro_mirror rows.';

-- ─── 3. ar_invoice_lines ─────────────────────────────────────────────────
ALTER TABLE ar_invoice_lines
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ar_invoice_lines_source_check'
  ) THEN
    ALTER TABLE ar_invoice_lines
      ADD CONSTRAINT ar_invoice_lines_source_check
        CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ar_invoice_lines_source ON ar_invoice_lines (source);

-- ─── 4. ar_receipts ──────────────────────────────────────────────────────
ALTER TABLE ar_receipts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ar_receipts_source_check'
  ) THEN
    ALTER TABLE ar_receipts
      ADD CONSTRAINT ar_receipts_source_check
        CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ar_receipts_source ON ar_receipts (source);

-- ─── 5. invoices (AP) ────────────────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_source_check'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_source_check
        CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_source ON invoices (source);

COMMENT ON COLUMN invoices.source IS 'T10 source-tagging on AP invoices. ''manual'' for operator-typed; ''xoro_mirror'' for T10 nightly mirror; ''edi_3pl'' for P22 future EDI-driven creation.';

-- ─── 6. journal_entries ──────────────────────────────────────────────────
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_source_check'
  ) THEN
    ALTER TABLE journal_entries
      ADD CONSTRAINT journal_entries_source_check
        CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries (source);

COMMENT ON COLUMN journal_entries.source IS 'T10 source-tagging on JEs. Distinct from existing source_module / source_table / source_id which identify the originating module + row.';

-- ─── 7. inventory_layers — extend existing source_kind enum ──────────────
--
-- inventory_layers already has `source_kind` enum:
--   'ap_invoice' / 'adjustment' / 'opening_balance' / 'transfer_in' /
--   'credit_memo_return'
--
-- T10 extends it with 'xoro_mirror_snapshot' so the mirror cron can
-- DROP + REBUILD only its own rows without touching operator-created
-- ones. CHECK constraint recreated additively.

ALTER TABLE inventory_layers
  DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check;

ALTER TABLE inventory_layers
  ADD CONSTRAINT inventory_layers_source_kind_check
    CHECK (source_kind IN (
      'ap_invoice',
      'adjustment',
      'opening_balance',
      'transfer_in',
      'credit_memo_return',
      'xoro_mirror_snapshot'
    ));

CREATE INDEX IF NOT EXISTS idx_inventory_layers_xoro_mirror
  ON inventory_layers (entity_id, source_kind)
  WHERE source_kind = 'xoro_mirror_snapshot';

COMMENT ON COLUMN inventory_layers.source_kind IS 'T10 added xoro_mirror_snapshot value. Mirror cron drops all rows of this kind nightly and rebuilds from ip_inventory_snapshot + item_costing. Other source_kinds (manual ops, real consumption, transfers) are never touched.';

-- ─── 8. xoro_mirror_runs — state tracking for nightly mirror cron ────────
CREATE TABLE IF NOT EXISTS xoro_mirror_runs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id               uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  domain                  text NOT NULL
                          CHECK (domain IN ('ar','ap','inventory','summary_je')),
  mirror_date             date NOT NULL,
  rows_upserted           int NOT NULL DEFAULT 0,
  rows_deleted            int NOT NULL DEFAULT 0,
  rows_unchanged          int NOT NULL DEFAULT 0,
  je_id                   uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  errors                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  status                  text NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','complete','failed','skipped_no_change','skipped_stale_xoro')),
  CONSTRAINT xoro_mirror_runs_unique UNIQUE (entity_id, domain, mirror_date)
);

CREATE INDEX IF NOT EXISTS idx_xoro_mirror_runs_recent
  ON xoro_mirror_runs (mirror_date DESC, domain);
CREATE INDEX IF NOT EXISTS idx_xoro_mirror_runs_status
  ON xoro_mirror_runs (status, mirror_date DESC)
  WHERE status IN ('failed','running');

COMMENT ON TABLE xoro_mirror_runs IS 'T10 nightly mirror cron state tracker. UNIQUE on (entity_id, domain, mirror_date) makes daily re-runs idempotent. status=skipped_stale_xoro fires when Xoro fetch hasn''t completed today.';

-- ─── 9. RLS template ──────────────────────────────────────────────────────
ALTER TABLE xoro_mirror_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'anon_all_xoro_mirror_runs' AND tablename = 'xoro_mirror_runs'
  ) THEN
    CREATE POLICY anon_all_xoro_mirror_runs
      ON xoro_mirror_runs FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 10. PostgREST schema cache reload ────────────────────────────────────
NOTIFY pgrst, 'reload schema';
