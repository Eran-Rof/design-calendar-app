// src/inventory-planning/utils/bucketUnitCost.ts
//
// Target resolution for the "apply a Unit Cost to a collapsed/aggregate
// row" fan-out. A collapsed grid row (e.g. by style / all-colors) carries
// `aggregate_underlying_ids` — the forecast_ids of every child that rolled
// up into it. Typing a cost into the aggregate cell should push that cost
// onto EVERY child, but the write path differs by child type:
//   - real forecast children → ip_wholesale_forecast.unit_cost_override
//   - TBD stock-buy children  → ip_wholesale_forecast_tbd.unit_cost
//
// This pure helper gathers the leaf targets and splits them so the
// workbench handler can batch each write to the correct table. Extracted
// so the id-gathering + TBD/forecast split is unit-testable.

import type { IpPlanningGridRow } from "../types/wholesale";

export interface BucketCostTargets {
  /** Regular forecast children → patchForecastUnitCostOverride(id, cost). */
  forecastIds: string[];
  /** TBD children → saveTbdField(row, { unit_cost }). */
  tbdRows: IpPlanningGridRow[];
}

// Resolve an aggregate row to its leaf unit-cost targets.
//
// Returns null when the row is NOT an aggregate (or carries no underlying
// ids) — the caller should then fall back to the single-row save path.
//
// Nested aggregates (a child that is itself an aggregate) are resolved
// down to their leaves. Ids that don't resolve in `byId` are skipped.
// Each leaf is visited at most once.
export function collectUnitCostBucketTargets(
  row: Pick<IpPlanningGridRow, "is_aggregate" | "forecast_id" | "aggregate_underlying_ids">,
  byId: Map<string, IpPlanningGridRow>,
): BucketCostTargets | null {
  const ids = row.aggregate_underlying_ids;
  if (!row.is_aggregate || !ids || ids.length === 0) return null;

  const forecastIds: string[] = [];
  const tbdRows: IpPlanningGridRow[] = [];
  const seen = new Set<string>();

  const visit = (fid: string): void => {
    if (seen.has(fid)) return;
    seen.add(fid);
    const child = byId.get(fid);
    if (!child) return;
    if (child.is_aggregate && child.aggregate_underlying_ids?.length) {
      for (const sub of child.aggregate_underlying_ids) visit(sub);
      return;
    }
    if (child.is_tbd) tbdRows.push(child);
    else forecastIds.push(child.forecast_id);
  };

  for (const fid of ids) visit(fid);
  return { forecastIds, tbdRows };
}

// Targets for propagating a manually-typed Unit Cost from a single
// (non-aggregate) row out to every OTHER non-aggregate row of the SAME
// style + color in the run (all periods, all customers). Rows of the same
// style+color share the same pack grain, so one typed value is valid for
// all of them — see #1852. Same shape as BucketCostTargets so the workbench
// handler reuses one chunk/sequence write pattern:
//   - regular forecast siblings → patchForecastUnitCostOverride(id, cost)
//   - TBD stock-buy siblings     → saveTbdField(row, { unit_cost })
export type StyleColorCostTargets = BucketCostTargets;

// Gather the propagation siblings of an edited row.
//
// Match rule: case-insensitive, whitespace-trimmed compare on BOTH
// sku_style and sku_color; both fields must be non-empty. Excluded:
//   - the edited row itself (by forecast_id)
//   - aggregate rows (their children are separate leaf rows already in the
//     list; we propagate onto leaves, never the roll-up)
//   - siblings of a different style or a different color
//   - the TBD placeholder color "TBD" (color must be a REAL color match) —
//     also short-circuits when the EDITED row's color is the "TBD"
//     placeholder, so a blank-color stock-buy row never fans out
//
// Returns empty lists (never null) when the edited row has no real
// style/color or has no siblings — the caller still writes the edited row.
export function collectStyleColorPropagationTargets(
  editedRow: Pick<IpPlanningGridRow, "forecast_id" | "sku_style" | "sku_color">,
  allRows: IpPlanningGridRow[],
): StyleColorCostTargets {
  const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
  const style = norm(editedRow.sku_style);
  const color = norm(editedRow.sku_color);

  const forecastIds: string[] = [];
  const tbdRows: IpPlanningGridRow[] = [];

  // Both fields must be real. Color must be an actual color, not the "TBD"
  // placeholder — a blank stock-buy row must not blanket every TBD row.
  if (!style || !color || color === "tbd") return { forecastIds, tbdRows };

  for (const r of allRows) {
    if (r.forecast_id === editedRow.forecast_id) continue;
    if (r.is_aggregate) continue;
    if (norm(r.sku_style) !== style) continue;
    if (norm(r.sku_color) !== color) continue;
    if (r.is_tbd) tbdRows.push(r);
    else forecastIds.push(r.forecast_id);
  }
  return { forecastIds, tbdRows };
}
