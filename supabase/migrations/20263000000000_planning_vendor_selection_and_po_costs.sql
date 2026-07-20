-- 20263000000000_planning_vendor_selection_and_po_costs.sql
--
-- Planning: vendor selection at the build stage + a vendor-first unit-cost
-- cascade for the wholesale planning grid (CEO ask: the same style is bought
-- from multiple vendors at different true costs, e.g. RYB0185PPK camo at
-- $121.20/pack from one vendor vs $122.16/pack from another). When a vendor is
-- selected on a build, the grid resolves each row's unit cost vendor-first:
--   1. OPEN POs for THIS vendor (style/color)
--   2. else most-recent RECEIVED POs for THIS vendor (style/color) price guide
--   3. else the existing avg cascade (direct -> sibling)
--   4. else any-vendor open-PO grain-aware fallback (the existing behavior)
-- When no vendor is selected, cost wiring is byte-identical to today.
--
-- Two pieces here:
--   (A) ip_planning_runs.build_vendor_id -- persists the vendor picked on the
--       run so grid rebuilds/reloads keep using it. References the portal
--       `vendors` table (that is where PO vendor identity actually lives:
--       ip_open_purchase_orders.vendor_id is 100% NULL and ip_vendor_master is
--       empty in prod, whereas native purchase_orders.vendor_id has 100%
--       coverage).
--   (B) two read views the browser (anon key) consumes for the selector and
--       the vendor-scoped cost tiers, sourced from the native
--       purchase_orders + purchase_order_lines + vendors + ip_item_master
--       join. purchase_order_lines.inventory_item_id references
--       ip_item_master(id) -- the SAME sku_id the planning grid keys on -- so
--       the tiers land on the exact grid rows. unit_cost is exposed in DOLLARS
--       (cents / 100) at the SKU's native grain (per-pack for PPK), matching
--       what the existing avg/open-PO cascade returns.
--
-- The views run with owner (postgres) rights (default non-security_invoker), so
-- granting SELECT to anon is sufficient; anon needs no direct grants on the
-- underlying procurement tables. This mirrors the internal-only posture of
-- every other ip_* planning surface the browser already reads with the anon key.

-- ── (A) vendor selection persisted on the run ────────────────────────────────
ALTER TABLE ip_planning_runs
  ADD COLUMN IF NOT EXISTS build_vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL;

COMMENT ON COLUMN ip_planning_runs.build_vendor_id IS
  'Optional vendor (vendors.id) selected at build time. Drives the vendor-first unit-cost cascade on the wholesale planning grid (tier 1 vendor open PO, tier 2 vendor most-recent received PO). NULL = any vendor (existing post-#1852 cascade, unchanged).';

-- ── (B1) selector: vendors that actually have usable native PO lines ─────────
-- Distinct vendors with at least one non-cancelled, cost-bearing PO line. Keeps
-- the build-stage dropdown focused on vendors you actually buy from (29 in prod
-- today) instead of the full 274-row portal vendor list.
CREATE OR REPLACE VIEW ip_po_vendors AS
SELECT DISTINCT
  v.id   AS vendor_id,
  v.name AS vendor_name,
  v.code AS vendor_code
FROM vendors v
JOIN purchase_orders po       ON po.vendor_id = v.id
JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
WHERE v.deleted_at IS NULL
  AND po.status <> 'cancelled'
  AND pol.unit_cost_cents > 0;

-- ── (B2) vendor-scoped per-line PO costs feeding tiers 1 and 2 ───────────────
-- One row per cost-bearing native PO line, tagged with its vendor + the grid's
-- sku identity. is_open flags lines still awaiting receipt (tier 1); qty_received
-- + order_date drive the most-recent received price guide (tier 2). Cancelled +
-- draft POs and zero-cost lines are excluded.
CREATE OR REPLACE VIEW ip_vendor_po_costs AS
SELECT
  po.vendor_id                                     AS vendor_id,
  im.sku_code                                      AS sku_code,
  im.pack_size                                     AS pack_size,
  (pol.unit_cost_cents::numeric / 100.0)           AS unit_cost,
  GREATEST(COALESCE(pol.qty_ordered, 0) - COALESCE(pol.qty_received, 0), 0) AS qty_open,
  COALESCE(pol.qty_received, 0)                    AS qty_received,
  (po.status IN ('issued', 'partially_received')
     AND COALESCE(pol.qty_ordered, 0) > COALESCE(pol.qty_received, 0))      AS is_open,
  (COALESCE(pol.qty_received, 0) > 0)              AS is_received,
  po.order_date                                    AS order_date,
  po.status                                        AS po_status
FROM purchase_order_lines pol
JOIN purchase_orders po ON po.id = pol.purchase_order_id
JOIN ip_item_master im  ON im.id = pol.inventory_item_id
WHERE po.status <> 'cancelled'
  AND po.status <> 'draft'
  AND pol.unit_cost_cents > 0
  AND im.sku_code IS NOT NULL;

GRANT SELECT ON ip_po_vendors     TO anon, authenticated, service_role;
GRANT SELECT ON ip_vendor_po_costs TO anon, authenticated, service_role;
