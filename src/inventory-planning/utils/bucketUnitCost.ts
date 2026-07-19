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
