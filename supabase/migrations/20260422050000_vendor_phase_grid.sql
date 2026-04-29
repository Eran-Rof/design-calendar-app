-- 20260422050000_vendor_phase_grid.sql
--
-- Vendor-facing PO phase grid.
--
-- Two tables:
--  1. vendor_phase_permissions — ROF controls which phases a given vendor
--     may request updates on. If no row exists for a (vendor, phase), the
--     default is "read-only" (can_edit = false).
--  2. tanda_milestone_change_requests — every vendor edit writes a pending
--     row here instead of mutating the internal tanda_milestones table. An
--     internal reviewer approves / rejects from the TandA side; the vendor
--     sees approval state in the grid.
--
-- RLS:
--   anon (internal app / service role) — full access
--   authenticated (vendor JWT)          — read/write only on own vendor_id

CREATE TABLE IF NOT EXISTS vendor_phase_permissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  phase_name    text NOT NULL,
  can_edit      boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  UNIQUE (vendor_id, phase_name)
);

CREATE INDEX IF NOT EXISTS idx_vpp_vendor ON vendor_phase_permissions (vendor_id);

ALTER TABLE vendor_phase_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_vpp" ON vendor_phase_permissions;
CREATE POLICY "anon_all_vpp" ON vendor_phase_permissions FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_read_own_vpp" ON vendor_phase_permissions;
CREATE POLICY "vendor_read_own_vpp" ON vendor_phase_permissions FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

CREATE TABLE IF NOT EXISTS tanda_milestone_change_requests (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  po_id                    uuid NOT NULL REFERENCES tanda_pos(uuid_id) ON DELETE CASCADE,
  po_number                text NOT NULL,
  phase_name               text NOT NULL,
  field_name               text NOT NULL, -- 'expected_date' | 'status' | 'status_date' | 'notes'
  old_value                text,
  new_value                text,
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at             timestamptz NOT NULL DEFAULT now(),
  requested_by_vendor_user_id uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  reviewed_at              timestamptz,
  reviewed_by_internal_id  text,
  review_note              text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcr_vendor_status ON tanda_milestone_change_requests (vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_mcr_po ON tanda_milestone_change_requests (po_id);

ALTER TABLE tanda_milestone_change_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_mcr" ON tanda_milestone_change_requests;
CREATE POLICY "anon_all_mcr" ON tanda_milestone_change_requests FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_read_own_mcr" ON tanda_milestone_change_requests;
CREATE POLICY "vendor_read_own_mcr" ON tanda_milestone_change_requests FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- Seed: grant every existing vendor full edit permission on the default
-- WIP phase set, so the grid is exercisable out of the box. ROF can
-- revoke via the TandA admin UI (future work).
INSERT INTO vendor_phase_permissions (vendor_id, phase_name, can_edit)
SELECT v.id, p.phase_name, true
FROM vendors v
CROSS JOIN (VALUES
  ('Lab Dip / Strike Off'),
  ('Trims'),
  ('Raw Goods Available'),
  ('Fabric at Printing Mill'),
  ('Fabric Finished Goods'),
  ('Fabric at Factory'),
  ('Fabric at Cutting Line'),
  ('Fit Sample'),
  ('PP Sample'),
  ('PP Approval'),
  ('Size Set'),
  ('Top Sample'),
  ('Fabric Ready'),
  ('Prod Start'),
  ('Packing Start'),
  ('Prod End'),
  ('Ex Factory'),
  ('Packing List / Docs Rec''d'),
  ('In House / DDP')
) AS p(phase_name)
ON CONFLICT (vendor_id, phase_name) DO NOTHING;
