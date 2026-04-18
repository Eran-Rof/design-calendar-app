-- 20260418110000_shipments_and_events.sql
--
-- Phase 1.6 — tables that back the Searates shipment tracking feature.
--
-- Design choices:
--   • One shipments row per (vendor_id, number, number_type). A single BL/BK
--     can carry multiple containers — we collapse the Searates response into
--     one summary row (pol/pod/eta/ata/current_status) and keep raw_payload
--     for any per-container detail the UI needs.
--   • shipment_events is a flattened list across all containers; container
--     attribution is preserved via container_number (nullable for BL-level
--     events).
--   • api_call_log is global (not per-vendor) so the internal team can see
--     cost + usage across all tenants. Authenticated vendors cannot read it.
--
-- RLS follows the Phase 0 pattern: anon-permissive (internal TandA Shipments
-- tab uses anon key) + authenticated-scoped (vendors see only their own).

-- ── shipments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id         uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  vendor_user_id    uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  po_number         text,
  number            text NOT NULL,
  number_type       text NOT NULL CHECK (number_type IN ('CT', 'BL', 'BK')),
  sealine_scac      text,
  sealine_name      text,
  pol_locode        text,
  pod_locode        text,
  pol_date          timestamptz,
  pod_date          timestamptz,
  eta               timestamptz,
  ata               timestamptz,
  current_status    text,
  last_tracked_at   timestamptz,
  raw_payload       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_vendor_number_type
  ON shipments (vendor_id, number, number_type);

CREATE INDEX IF NOT EXISTS idx_shipments_vendor_id   ON shipments (vendor_id);
CREATE INDEX IF NOT EXISTS idx_shipments_po_number   ON shipments (po_number) WHERE po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_current_status ON shipments (current_status);

-- ── shipment_events ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id       uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  container_number  text,
  order_id          integer,
  event_code        text,
  event_type        text,
  status            text,
  description       text,
  location_locode   text,
  facility_name     text,
  event_date        timestamptz,
  is_actual         boolean NOT NULL DEFAULT false,
  raw_json          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment_id ON shipment_events (shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_events_date        ON shipment_events (event_date);

-- ── api_call_log ─────────────────────────────────────────────────────────────
-- Rule of Phase 1: every Searates call is user-initiated. This table records
-- WHO called, WHEN, the force_update flag, and a cost estimate so we can see
-- the bill before the Searates portal does.
CREATE TABLE IF NOT EXISTS api_call_log (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_name               text NOT NULL DEFAULT 'searates',
  caller_auth_id         uuid,
  number                 text,
  number_type            text,
  force_update           boolean NOT NULL DEFAULT false,
  response_status        integer,
  response_message       text,
  estimated_cost_cents   integer,
  duration_ms            integer,
  called_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_call_log_called_at ON api_call_log (called_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_call_log_caller    ON api_call_log (caller_auth_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE shipments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_call_log     ENABLE ROW LEVEL SECURITY;

-- shipments
DROP POLICY IF EXISTS "anon_all_shipments" ON shipments;
CREATE POLICY "anon_all_shipments" ON shipments
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_shipments_select" ON shipments;
CREATE POLICY "vendor_own_shipments_select" ON shipments
  FOR SELECT TO authenticated
  USING (
    vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "vendor_own_shipments_insert" ON shipments;
CREATE POLICY "vendor_own_shipments_insert" ON shipments
  FOR INSERT TO authenticated
  WITH CHECK (
    vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "vendor_own_shipments_update" ON shipments;
CREATE POLICY "vendor_own_shipments_update" ON shipments
  FOR UPDATE TO authenticated
  USING (
    vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

-- shipment_events
DROP POLICY IF EXISTS "anon_all_shipment_events" ON shipment_events;
CREATE POLICY "anon_all_shipment_events" ON shipment_events
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_shipment_events_select" ON shipment_events;
CREATE POLICY "vendor_own_shipment_events_select" ON shipment_events
  FOR SELECT TO authenticated
  USING (
    shipment_id IN (
      SELECT s.id FROM shipments s
      WHERE s.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  );

-- api_call_log
-- Internal team (anon) can read/write for cost monitoring.
-- Vendors do NOT get a read policy — call logs may reveal cross-vendor data.
DROP POLICY IF EXISTS "anon_all_api_call_log" ON api_call_log;
CREATE POLICY "anon_all_api_call_log" ON api_call_log
  FOR ALL TO anon USING (true) WITH CHECK (true);
