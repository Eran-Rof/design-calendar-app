# Tangerine P16 — Sales (Order Entry, Allocations, Line Review, Carrier)

**Phase:** P16 (after P15 Brand Master). **Modules:** M10 Sales Orders · M18 Product Allocations · M24 Showroom / Line Review · M44 Carrier.
**Status:** architecture (this doc) + M10-A schema. Build proceeds chunk by chunk.

## Why now / what exists
- Today `ip_open_sales_orders` is a **read-only Xoro feed** — there is no native SO entry. P16 adds first-class sales orders so wholesale/showroom orders originate in Tangerine (a prerequisite for retiring Xoro and for Planning/P17, which consumes SO demand).
- Reuse, don't rebuild: the **ATS / inventory-planning app** (`src/ats`, `src/inventory-planning`) is the planning + availability surface (P17 builds on it); SO **allocations** (M18) draw against the same ATS availability + FIFO layers. SO entry reuses the existing invoice-modal patterns (customer/ship-to pickers, item SearchableSelect, supporting docs) and the brand/channel + entity scoping already in place.

## Data model (M10-A)
- **`sales_orders`** (header): `id, entity_id (default rof_entity_id()), brand_id, channel_id, customer_id, ship_to_location_id, so_number (system-assigned, immutable), order_date, requested_ship_date, cancel_date, status, currency, payment_terms_id, ar_account_id/revenue_account_id overrides, notes, totals (subtotal/total cents), created/updated/by`.
- **`sales_order_lines`**: `id, sales_order_id, line_number, inventory_item_id (optional), description, qty_ordered, qty_allocated, qty_shipped, qty_invoiced, unit_price_cents, line_total_cents, revenue_account_id (optional), status`.
- **Status lifecycle:** `draft → confirmed → allocated → fulfilling → shipped → invoiced → closed` (+ `cancelled`). Drives downstream gating (can't allocate a draft, can't invoice un-shipped, etc.).
- SO number auto-assigned on confirm (never operator-editable — same rule as AR invoice numbers).

## Chunk sequence
1. **M10-A — schema** (this PR): `sales_orders` + `sales_order_lines` + status enum + indexes + RLS (anon-read-only) + T11 audit trigger. Inert (no UI yet).
2. **M10-B — SO entry panel**: list + create/edit modal (customer + ship-to + brand/channel + line items via the item SearchableSelect + supporting docs). Mirrors the AR/AP invoice modals. SO number auto-assigned on confirm.
3. **M10-C — SO → AR invoice**: generate a draft AR invoice from a (shipped) SO, carrying lines + accounts; ties `qty_invoiced`.
4. **M18 — Product Allocations**: allocate on-hand / incoming (ATS availability + FIFO) to SO lines; allocation grid (Style×Color×Size), updates `qty_allocated`. Gating: confirmed SOs only.
5. **M24 — Showroom / Line Review**: seasonal line-review/selection surface feeding SO creation (buyer picks styles/qtys → draft SOs).
6. **M44 — Carrier / fulfillment**: carrier + tracking on shipment; flips lines to `shipped`, feeds M10-C invoicing.

## Cross-cutters already available (reused)
Brand/channel scoping (`applyBrandScope`), entity scoping, T11 audit (`audit_row_changes_trigger`), approvals, documents (`DocumentAttachmentList` + staged upload), the canonical warn surface, `SearchableSelect` (now portal-safe in modals), customer ship-to locations.

## Out of scope (later phases)
SO demand → Planning is **P17** (consumes SO via ATS). EDI order intake is **P22**. B2B self-service order placement is **P18**.

## M18 Allocations Workbench (#788)
Standalone `Sales → Allocations` screen (`src/tanda/InternalAllocations.tsx`) — the cross-SO allocation surface the per-SO `📦 Allocate stock` button (#725) couldn't provide.

- **Data (`v_allocation_demand`):** one row per manageable open SO line (confirmed/allocated/fulfilling, not split-parent, not fully shipped), carrying `is_factored` / `has_card` + factor fields. The GET handler joins it with `v_inventory_available` (on-hand / reserved / available per item). The grid groups **style/color rollup → SKU (size) → competing SO lines**; the rollup is a *view* only — allocation always resolves at size-level SKU, so a style/color target can never allocate sizes with zero stock.
- **Priority tiering (auto-allocate):** **(1) factor-approved → (2) non-factored w/ stored card → (3) oldest** (`order_date` asc within each tier). The strategy is **chosen at run time** in the preview dialog; preview (`/allocations/preview`) computes the proposal with no write so the operator sees the exact per-SKU/per-SO grants (and blocked rows) before applying.
- **Fill modes (#789):** **(a) Priority full-fill** — each order 100% in priority order until stock runs out; **(b) Fair-share** — pro-rata by open qty (water-fill, leftover units by priority); **(c) Capped %** — priority full-fill with a ceiling of N% of open qty, basis **per SKU line** or **per SO style/color** (group budget spread across sizes). All bounded by the live per-item pool and the factor $ headroom, so a style/color % target can never allocate a zero-stock size.
- **Hard factor-credit gate** (enforced in `apply_allocations`, surfaced in preview): a factored customer's SO can only be allocated when `factor_approval_status='approved'` AND `factor_reference` is non-empty AND the resulting SO allocated $ (Σ qty_allocated × unit_price_cents) ≤ `factor_approved_cents`. Otherwise the line is skipped with a reason.
- **Write path (`apply_allocations(jsonb, uuid)` RPC):** single authoritative absolute-SET of `qty_allocated` per line (0 releases), used by both manual cell edits and Auto-apply. Validates against a running per-item available pool; recomputes line + SO header status. FIFO consumption is unchanged (stays at invoice/ship). No partition/brand netting in v1 (`BRAND_SCOPE_MODE` off).
- **Fast-follow:** partition/brand-aware netting (`BRAND_SCOPE_MODE` off); fair-share redistribution of factor-$-capped surplus.

## Deferred / planned
- **Rosenthal & Rosenthal Factor API integration** — auto-fill the SO Factor/Ins Approval fields (`factor_approval_status`, `factor_approved_cents`, `factor_reference`) from the factor's API instead of manual entry. **Scheduled AFTER Xoro retirement** (per operator, 2026-06-01) — defer until the Xoro nightly pipeline is decommissioned so integration effort isn't split. Schema is already in place (`factor_source` enum reserves `rosenthal_api`); only the connector + a sync job remain.
