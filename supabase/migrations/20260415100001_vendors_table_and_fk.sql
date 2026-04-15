-- 0001_vendors_table_and_fk.sql
--
-- Materializes vendors (currently a JSON blob in app_data where key='vendors')
-- into a proper table, and adds tanda_pos.vendor_id FK so the vendor portal
-- can filter POs by vendor via RLS.
--
-- Safe to run: creates new table + adds nullable column + index. No data
-- modified. The app_data['vendors'] blob is left untouched — internal apps
-- continue reading/writing it. Migration 0002 installs a trigger that mirrors
-- future blob writes into this table.

-- ── vendors table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_blob_id    text UNIQUE,                -- original id from app_data['vendors'] JSON record
  name              text NOT NULL,
  country           text,
  transit_days      integer,
  categories        text[] DEFAULT '{}',
  contact           text,
  email             text,
  moq               integer,
  lead_overrides    jsonb DEFAULT '{}'::jsonb,
  wip_lead_overrides jsonb DEFAULT '{}'::jsonb,
  aliases           text[] DEFAULT '{}',        -- manual overrides for fuzzy-matching future PO vendor strings
  deleted_at        timestamptz,                -- soft-delete (vendors removed from JSON blob)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive unique index on name (among non-deleted rows) so the
-- backfill can fuzzy-match confidently.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_name_ci_active
  ON vendors (lower(name)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vendors_legacy_blob_id ON vendors (legacy_blob_id);

-- ── tanda_pos.vendor_id FK ───────────────────────────────────────────────────
-- Nullable so existing rows stay valid until the backfill runs (0.3).
-- ON DELETE RESTRICT: we never hard-delete vendors (soft-delete via deleted_at),
-- so this mainly guards against accidents.
ALTER TABLE tanda_pos
  ADD COLUMN IF NOT EXISTS vendor_id uuid
    REFERENCES vendors(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tanda_pos_vendor_id ON tanda_pos (vendor_id);
