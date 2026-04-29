-- 20260503000000_ip_item_avg_cost_rls.sql
--
-- Phase 0 set up an anon_all policy on the planning tables enumerated
-- there, but ip_item_avg_cost was added later (20260501000000) without
-- one. Browser-side Excel uploads then hit 401 on every chunk because
-- the anon role has neither table-level GRANT nor an RLS policy that
-- permits writes.
--
-- This migration mirrors the phase 0 anon-permissive pattern for the
-- avg-cost table: enable RLS, drop any stale policy, recreate FOR ALL
-- with USING/WITH CHECK true.

ALTER TABLE ip_item_avg_cost ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_ip_item_avg_cost" ON ip_item_avg_cost;
CREATE POLICY "anon_all_ip_item_avg_cost" ON ip_item_avg_cost
  FOR ALL TO anon
  USING (true) WITH CHECK (true);

-- Some PostgREST setups require explicit table-level grants in addition
-- to RLS — phase 0's anon role is granted broad table privileges by
-- default in this project, but be defensive in case the avg-cost table
-- was created after those grants ran.
GRANT SELECT, INSERT, UPDATE, DELETE ON ip_item_avg_cost TO anon;
