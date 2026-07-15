# On-Hand: Single Source of Truth (design)

**Status:** proposed — awaiting sign-off before build
**Author:** planning + Claude, 2026-07-15
**Goal:** planning on-hand and the Tangerine on-hand feed must be **identical (100%)**, warehouse-aware, sourced from **one** daily Xoro pull.

---

## 1. Problem

Today there are **two independently-captured on-hand feeds** that will never agree at 100% because they are two different extractions with two different resolutions:

| | Planning default ("Xoro/ATS mirror") | Tangerine truth |
|---|---|---|
| Table | `ip_inventory_snapshot` (`source='manual'`) | `tangerine_size_onhand` |
| Grain | **color** (size collapsed) | **size** |
| Mechanism | **ATS Excel upload** (`syncOnHandFromAtsSnapshot`) | **Xoro REST by-size pull** (`verify_tangerine_onhand.py`) |
| Cadence | ad-hoc uploads | month-end (May 31, Jun 30, Jul 1 …) |
| Warehouse | single `DEFAULT` (all lumped) | 4 real: **ROF Main, Psycho Tuna, ROF-ECOM, Psycho Tuna Ecom** |

**Measured divergence** (Tangerine Jul-1 vs ATS Jul-3, rolled to style+color): 1,291 exact matches, **748 style+colors present in only one feed** (~346k units), 121 quantity diffs (~23k units) — a ~5% gap. The 07:30 `inventory-onhand-check` cron already monitors this (the #1763 accuracy monitor: ~2,367 SKUs diverge).

**Two contributing bugs already fixed (2026-07-15):**
- ATS `snapshot_date` was the feed's *max Last Receipt Date*; a future-dated incoming receipt stamped the whole snapshot 5 months ahead (#1775 clamps at today).
- Color-casing duplicate SKUs fragmented on-hand across master rows (84k Tangerine units) — merged, all colors Title-Cased.

**Conclusion:** you cannot reconcile two divergent feeds to 100% after the fact — the next capture re-diverges. The only way to 100% is a **single source**.

---

## 2. Target architecture

```
        Xoro REST (by-size on-hand, per warehouse)
                        │   ONE daily pull, ONE resolver
                        ▼
        tangerine_size_onhand  (size grain, per warehouse) ── truth
                        │   roll-up writer (new)
                        ▼
        ip_inventory_snapshot  (source='tangerine', per warehouse)
             ╱                              ╲
   Wholesale planning                 Ecom planning
   on-hand = ROF Main +               on-hand = ROF-ECOM +
   Psycho Tuna                        Psycho Tuna Ecom
```

There is now exactly **one** on-hand number per (SKU, warehouse, day). Planning's "Xoro/ATS mirror" and "Tangerine ERP" sources both read it, so they are identical **by construction** — nothing to diverge.

### 2.1 Warehouse / channel model (per operator, 2026-07-15)

Planning is run **separately for Wholesale and Ecom**, and each channel maps to a fixed warehouse set:

| Planning channel | Warehouses summed for on-hand |
|---|---|
| **Wholesale** | **ROF Main** + **Psycho Tuna** |
| **Ecom** | **ROF-ECOM** + **Psycho Tuna Ecom** |

On-hand is stored **per warehouse** in `ip_inventory_snapshot` (its unique key already includes `warehouse_code`), and each planning channel sums its own warehouse set. A wholesale run never counts ecom stock and vice-versa.

---

## 3. Data flow & tables

- **`tangerine_size_onhand`** stays the raw Xoro-REST landing table (size grain, per warehouse). Unchanged.
- **Roll-up writer (new)** runs right after the pull: for the latest `snapshot_date`, aggregate `tangerine_size_onhand` → `ip_inventory_snapshot` at planning grain, **preserving `warehouse_code`**, under `source='tangerine'` (the reader already isolates 'tangerine' via source!=tangerine, so this stays additive; a NEW source value would be swept into the default reader and double-count).
  - Grain: planning's wholesale forecast is color grain today; ecom is SKU/week. The roll-up writes **color grain per warehouse** for wholesale (sum sizes within color) and keeps SKU grain for ecom as needed. (Open Q 6.1 — confirm the exact grain per channel during build.)
  - Idempotent upsert on `(sku_id, warehouse_code, snapshot_date, source)`.
- **`ip_inventory_snapshot`** gains a canonical `source='tangerine'` alongside the legacy `manual` (ATS) rows, so the change is **additive** until cutover.

---

## 4. Reader changes

- `wholesalePlanningRepository.listInventorySnapshots(...)` and the ecom equivalent become **channel/warehouse-aware**: read `source='tangerine'`, filter to the channel's warehouse set, sum per SKU.
- The "Tangerine ERP" vs "Xoro/ATS mirror" supply-source toggle collapses to a single source (both read `tangerine`). The toggle can stay as a no-op/label during transition, then be removed.
- Inventory Matrix / ATS-by-size already read `tangerine_size_onhand` directly — unchanged (they stay size-grain).

---

## 5. Rollout (staged; each verifiable)

1. **PR1 — roll-up writer + backfill (additive, non-destructive).** Build the `tangerine_size_onhand → ip_inventory_snapshot (source='tangerine', per warehouse)` transform; backfill the latest date. Verify planning-grain on-hand from `tangerine` **ties to `tangerine_size_onhand` to the unit**. No reader change yet — nothing user-visible.
2. **PR2 — channel/warehouse-aware reader + flip.** Point planning's on-hand reader at `source='tangerine'` with the wholesale/ecom warehouse sets. Now both planning sources are identical.
3. **PR3 — deprecate the ATS Excel on-hand path** for planning (the ATS app keeps its Excel for its own screens). Stop writing `source='manual'` for planning; retire the supply-source toggle.
4. **PR4 — daily-cadence hardening.** Ensure the Xoro by-size pull + roll-up run **daily** (today `tangerine_size_onhand`'s latest is month-end Jul 1; the nightly `RofXoroDailyFetch` fix from 2026-07-15 helps). Add a freshness check to the 07:30 monitor.

Cutover is behind PR2's flip; **rollback** = point the reader back at `source='manual'` (the Excel rows are left intact until PR3).

---

## 6. Open questions to resolve during build

1. **Grain per channel.** Wholesale forecast is color grain; confirm the roll-up writes color-grain-per-warehouse for wholesale and whether ecom needs SKU-grain-per-warehouse.
2. **Warehouse naming.** Confirm the exact `warehouse_code` strings from the Xoro pull (`ROF Main`, `Psycho Tuna`, `ROF - ECOM`, `Psycho Tuna Ecom`) and pin the wholesale/ecom mapping in one config (`CHANNEL_TO_WAREHOUSES`).
3. **Snapshot date.** The roll-up dates rows to `tangerine_size_onhand`'s `snapshot_date` (Xoro-derived, already clamped ≤ today). Planning keeps "latest per SKU."
4. **PPK grain.** `tangerine_size_onhand` returns Xoro native grain (packs for PPK). Confirm the roll-up normalizes consistently with the planning grid's PPK handling.
5. **Costing.** On-hand valuation reads `ip_item_master.unit_cost` / `ip_item_avg_cost` — unaffected, but re-verify after the source flip.
6. **Zero rows.** Decide whether to write zero-on-hand rows (affects "only in one feed" coverage) — recommend writing only qty≠0, consistent with the pull.

---

## 7. Why this reaches 100%

After PR2 there is exactly **one** on-hand dataset. "Planning on-hand" and "Tangerine on-hand" are the **same rows filtered by warehouse**, so they cannot differ — the mirror is exact by construction, not by reconciliation. Remaining accuracy questions become "is the Xoro pull correct?", answered once, in one place.
