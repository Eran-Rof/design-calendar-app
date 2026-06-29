# AI Change Review — for operator sign-off

> A running log of substantive changes Claude made, with **notes, rationale, and caveats**, so the operator can review and confirm. Newest first. Cosmetic/mechanical fixes are summarized; **data migrations and behavior changes are called out with a ⚠️ REVIEW flag**.
>
> Convention: each entry = date · PR(s) · what changed · **why** · **what to verify**. Claude appends here whenever a change is non-trivial or touches production data.

---

## 2026-06-14 — Two-week deployed-PR bug-audit: order-entry + costing fixes

Audited the ~2 weeks of merged PRs (8 parallel subsystem reviews). This batch fixes the confirmed correctness bugs in **order entry** and the **costing export**:

| Fix | What was wrong | What to verify |
|----|--------|--------|
| **Inseam round-trip** (SO/PO/AR matrix) | Editing an existing order — or **Create-PO-from-SO** — for a style with inseams **dropped/overwrote the quantities** (seed cells carried no inseam, so they didn't match the per-inseam matrix rows). Single-inseam styles also lost their cost/on-hand/ATS hints. | Open an existing PO/SO for a denim style with inseams → the previously-ordered qtys now show in the grid; Create PO from such an SO → all sizes/inseams carry over. |
| **PO carton roll-up math** | A PPK line with no parseable pack size counted **1 carton per unit**; a style with **both** packs and loose eaches dropped the loose cartons; the "complete" flag stayed green while silently computing 0 cartons. | PO header roll-up → cartons/CBM are sane for mixed PPK + each styles; "missing weight/carton/CBM" hint shows when a style lacks `units_per_carton`. |
| **AI Upload customer PO — colour match** | When the PO colour text didn't token-match a style colour, the qty (and price) landed on a **phantom row** and silently vanished. Now it lands on a real colour (visible) and raises a "verify the colour" note. | Upload a PO whose colour wording differs from our colour names → the qty appears on a colour row + a review note lists the mapping. |
| **AI Upload — dates & PPK totals** | A US `MM/DD/YYYY` date from the model was silently dropped (only ISO accepted); a PPK line given only a per-size breakdown (no scalar total) was left blank. | Upload a PO with `06/14/2026` dates and a PPK line with only size rows → dates + cartons prefill. |
| **Costing export — LY Margin %** | The "LY MARGIN %" Excel column exported the raw fraction (`0.2` instead of `20`). | Export the costing grid → LY MARGIN % matches the on-screen value. |

No DB migration; behaviour/display fixes only. (Separate follow-up PRs cover the Manufacturing-module GL/RLS fixes and the nightly received-date sync guard.)

## 2026-06-14 — Manufacturing-module bug-audit fixes (GL integrity + RLS)

⚠️ **REVIEW — financial-integrity fixes in the new Manufacturing module.** From the two-week deployed-PR audit:

- **Cancel of an ISSUED build is now blocked.** An issued build has already FIFO-consumed its parts/styles into WIP and posted the DR-WIP entry; the old PATCH let it flip to `cancelled` with **no reversing entry**, stranding the WIP balance and destroying the consumed inventory. Only draft/released builds (nothing consumed yet) can be cancelled until an explicit reverse-issue path exists.
- **Per-component WIP cost write-back is now positional.** `issue.js` keyed the FIFO consume results by `part_id` / `component_item_id`, so a BOM that legitimately lists the **same part or style on two lines** collapsed to one cost — mis-stamping the line and making `accumulated_cost_cents` diverge from the GL WIP debit (WIP wouldn't net to zero on completion). Now aligned by position (the drains return one result per component in declared order). **Verify:** a build with a duplicated component completes with WIP back to 0.
- **RLS enabled on `part_master`, `service_item_master`, `part_type_master`** (migration `20260892000000`) — they shipped without it, unlike every sibling mfg table, leaving part costs / vendors writable via the anon key with no entity scoping. Same `anon_all` + `auth_internal` policy pair as `mfg_bom`. Idempotent.

**Investigated, NOT a bug (no change):** the finished-goods account allegedly resolving differently between the manual-complete and PO-receipt paths — both pass a null brand and `accountByCode` already filters to postable, so the two resolvers return the identical account. **Deferred (P2, documented):** the finished FIFO layer is valued at `floor(total/qty)×qty`, up to (qty−1) cents under the GL debit — standard integer-cents FIFO drift; GL stays balanced.

## 2026-06-14 — Nightly received-date sync: forward-only guard

⚠️ **REVIEW — nightly RPC behavior change.** `sync_received_dates` (the Xoro "Last Receipt Date" sync wired into `/api/ats/upload`) updated any eligible layer whose date merely **differed** from the snapshot, so a snapshot reporting an **older** receipt than what's stored moved the date **backward** ("last received" could regress; FIFO age could shift wrongly). Migration `20260893000000` makes the update **forward-only** (`received_at IS NULL OR received_at::date < snapshot`). Idempotent; native PO-receipt layers still untouched. **Known limitation (unchanged):** one snapshot date per (style, colour) → a SKU's multiple Xoro/opening layers all get the same max date (display via max-per-cell stays correct). **Verify:** a nightly run no longer lowers any `received_at`.

## 2026-06-09 — PPK prepack matrices seeded (operator CSV)

⚠️ **REVIEW — production master-data bulk insert.** From the operator's `matrices ppk.csv` (6 templates), Claude **created 116** `prepack_matrices` + their size/inner-pack composition and **refreshed 15** existing RCB matrices → **135 active**. Matched by style prefix + pack token: RBB-PPK48 (8/10/12/14 ×12 = 48), RBB-PPK24 (×6), RCB-PPK60 (4/5/6/7 ×15 = 60), RCB-PPK24 (×6), RYO-PPK18 (SML3/MED6/LRG6/XLG3 = 18, alpha). Each size row carries `qty_per_pack` (carton) **and** `inner_pack_qty`. **Those PPK styles now explode** in the Inventory Matrix (Explode toggle, #1107). **Still open:** **83 PPK styles need operator guidance** → `Producton Orders/PPK_matrices_need_guidance.xlsx` (4 categories): **26 RYB denim** need a WAIST curve (RYB-PPK24 template is ALPHA, doesn't fit); **42** have no template for their prefix (RYG/ACMB/RBG/RBO/RG/RCO/RJO/CYB/SP/R); **14** have no pack-token SKU; **1** (RBB1042-PPK) ambiguous (PPK40/44/48). **Verify:** spot-check a seeded style (e.g. RYO0730PPK → Explode shows SML/MED/LRG/XLG eaches).

## 2026-06-08 — Nav polish: faded active highlight + favorites-only (#1124, #1135)

The selected menu item's bright royal-blue highlight is now a soft `rgba(59,130,246,0.16)` tint. Selecting a view **from Favorites** no longer auto-expands or highlights that module's copy in the menu below — only the favorites row shows selected (cleared on any other navigation). No data change.

## 2026-06-08 — 3PL Recon: nightly SFTP auto-pull (#1114)

Made the 3PL recon hands-off. New cron `/api/cron/tpl-inventory-pull` (02:30 UTC) SFTP-pulls each provider's newest inventory file, parses (846/CSV), and reconciles via the shared `reconcileSnapshot`. Added `ssh2-sftp-client` dependency (lockfile updated). New `tpl_providers` columns `inventory_sftp_path/last_inventory_file/last_inventory_pulled_at` (migration `20260840000000`, **PROD-applied**). Configure per provider in the recon panel's **⚙ Auto-pull (SFTP)** section. **Verify:** the secret stays in an env var (named by `edi_credential_ref`), never the DB; the nightly run ingests + dedupes via `last_inventory_file`. ⚠️ New native-ish dep (ssh2) — watch the first Vercel build.

## 2026-06-08 — 3PL Inventory Recon (#1112)

New nav module **Inventory → 📋 3PL Inventory Recon** + endpoint. Ingest a 3PL's on-hand snapshot (EDI **846**, CSV, or JSON) → stores dated snapshot → recomputes per-SKU differences vs Tangerine on-hand (`inventory_layers`), comparable vs the provider's location or total. New tables `tpl_inventory_snapshots/_lines/_differences` (migration `20260839000000`, **applied to PROD**). `module_keys` row seeded. **What to verify:** set a provider's **location** in the 3PL master, paste a CSV of `sku,qty`, Ingest → differences grid (compare vs **Total** until 945 relocates layers to the 3PL location). ⚠️ Ingest is push-based (no SFTP pull cron yet); 3PL fees + layer relocation still deferred.

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
