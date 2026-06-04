-- Vendor-scoped SELECT on native purchase_orders (defense-in-depth).
-- purchase_orders previously had ONLY an anon read policy, so a logged-in
-- vendor (role = authenticated) matched no policy. This adds the standard
-- vendor scoping used across invoices/shipments/tanda_pos. The anon policy
-- is intentionally left untouched (internal apps query via the anon key).
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vendor_own_purchase_orders_select" ON purchase_orders;
CREATE POLICY "vendor_own_purchase_orders_select" ON purchase_orders
  FOR SELECT TO authenticated
  USING (
    vendor_id IN (
      SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
    )
  );
