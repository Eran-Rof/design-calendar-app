# AI Change Review — for operator sign-off

> A running log of substantive changes Claude made, with **notes, rationale, and caveats**, so the operator can review and confirm. Newest first. Cosmetic/mechanical fixes are summarized; **data migrations and behavior changes are called out with a ⚠️ REVIEW flag**.
>
> Convention: each entry = date · PR(s) · what changed · **why** · **what to verify**. Claude appends here whenever a change is non-trivial or touches production data.

---

## 2026-06-08 — Inventory batch (#1105–#1110)

| PR | Change | Verify |
|----|--------|--------|
| #1105 | SO modal Save buttons pinned (sticky footer) | Open a tall SO → Save/Confirm always visible |
| #1105 | **Avg cost** fetch now keyed off SKU code stems, not the (renamed) style code | Inventory Matrix → renamed denim styles (RYB0869) show Avg Cost again |
| #1105 | User Access: per-group select-all checkbox | RBAC grid → group header checkbox grants all in group |
| #1107 | PPK **self-explode** + brand-view explode toggle | See ⚠️ below |
| #1108 | Left-nav + Favorites are real links → open in new tab | Right/middle/Cmd-click a nav item |
| #1106 | ExportButton → **Excel or PDF** dropdown (PDF via print-window, no new dep) | Any export → pick PDF |
| #1110 | **22 modals** clamped responsive (`min(cap,95vw)` + `90vh` + scroll) | Modals fit on small screens |

⚠️ **REVIEW — PPK explode is code-complete but data-blocked.** Only **7 of 49** PPK styles with on-hand have a prepack matrix; the other **42** (e.g. ACMB0016PPK, CYB0011-PPK) can't explode until their size composition is defined. Operator is building full PPK / inner-pack detail; Claude to bulk-seed matrices once the size curves are provided.

## 2026-06-07/08 — Inseam: scale field, matrix view, and **style merges** (#1093, #1096, #1098, #1104, + data)

⚠️ **REVIEW — irreversible-ish PRODUCTION DATA migration.** Inseam was encoded in denim **style-code suffixes** (RYB086930/32/34 = one jean in 3 inseams). Claude **merged sibling styles into one base** and stamped `ip_item_master.inseam`, and **stamped + renamed 84 single-inseam styles** (e.g. ACMB000130 → ACMB0001).

- **42 style families merged** + **84 singletons renamed/stamped** = 126 styles now carry inseam. SKUs kept their original `sku_code` (UPC-safe); old style rows soft-deleted.
- Code: `size_scales.inseams` field (Size Scale Master), Inventory Matrix **By Inseam** toggle (single + brand view), no-subtotal for single-inseam colors.
- **48 styles intentionally left alone** (trailing digits were a design number, not inseam — tops/joggers/jackets). List: `Producton Orders/sql/inseam_could_not_change.csv`.
- ⚠️ **Side effect Claude then fixed (#1105/#1107):** the renames broke avg-cost prefix matching and PPK-matrix references — both repaired. Watch for any other report/integration that assumed the old style codes.
- **What to verify:** spot-check a few merged styles (RYB0869, RYB0594) in Inventory Matrix → By Inseam shows 30/32/34 rows; confirm on-hand totals match expectations; confirm no downstream report lost a style.

## 2026-06-07 — Brand reassignment by style prefix (PROD data)

⚠️ **REVIEW — bulk `style_master.brand_id` update.** Claude reassigned brands by style-code prefix per operator rules (R→Ring of Fire, PT→Psycho Tuna, F→Fort Knox, BR→Blue Rise, AX→Axe Crown, D→Departed, 100+M→MPL Sun & Stone, 100+B/C/G→MPL Epic; plus ACMB→Axe Crown, CYB/CYT→ROF, PYB/PYT→PT). **~418 styles changed**; 48 unmatched left as-is (`Producton Orders/sql/unmatched_styles_no_brand_rule.csv`). Verify brand distribution looks right.

## 2026-06-07 — JE sequential numbers (#1083/#1088)

Journal entries now get `JE-YYYY-NNNNN` (DB trigger, immutable). Backfilled existing JEs. No review needed — additive.

---

### Items awaiting operator input
1. **PPK / inner-pack detail** — operator building; Claude to bulk-seed prepack matrices once size curves given.
2. **3PL nightly inventory differences report** — not built; scoped (EDI 846 / CSV ingest → snapshots → recon cron vs `inventory_layers` → differences panel).
3. **3PL 945 receiving does not relocate FIFO layers** to the 3PL location (status-only today) — deferred.
