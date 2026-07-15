// Pure planner for the "Shift Buyer −1 month" toolbar action on the Wholesale
// grid. Given the (Supply Only) TBD rows, it computes the minimal set of writes
// that move every Buyer quantity to the SAME style/color's prior-month row —
// i.e. the whole schedule slides one month earlier (Apr 1,200 → Mar 1,200;
// the last month empties; the earliest month's qty lands in the month before
// it, creating that row if it doesn't exist).
//
// Kept side-effect-free so the shift math is unit-tested; the workbench applies
// the returned ops (patch existing rows, insert the prior-month rows).

import type { IpPlanningGridRow } from "../../types/wholesale";
import { monthOffset } from "../../compute/periods";

export interface BuyerShiftOp {
  /** Target month for this write. */
  period_start: string;
  period_code: string;
  period_end: string;
  style_code: string;
  color: string;
  /** New buyer_request_qty at (style, color, target month). */
  new_buyer: number;
  /** tbd_id of the existing row at the target grain, when one exists (→ patch).
   *  Absent → the workbench must insert a new row (only happens for new_buyer>0). */
  existing_tbd_id?: string;
  /** A source row from the same (style, color) group — supplies customer_id,
   *  group_name, sub_category_name, is_new_color when a new row must be created. */
  template: IpPlanningGridRow;
}

const key = (style: string | null | undefined, color: string | null | undefined): string =>
  `${(style ?? "").trim().toLowerCase()}|${(color ?? "").trim().toLowerCase()}`;

/**
 * Plan the one-month-back shift of Buyer quantities across the given rows
 * (already scoped to the customer(s) the caller wants, e.g. Supply Only).
 *
 * Rule: every month takes the Buyer qty of the month AFTER it, so the schedule
 * shifts one month earlier. Emits only rows whose Buyer actually changes:
 *  - existing rows whose value differs from the shifted value → patch;
 *  - prior-month targets with a non-zero shifted value but no row yet → create.
 * Rows unaffected by any move are left untouched.
 */
export function planBuyerShiftBackOneMonth(rows: IpPlanningGridRow[]): BuyerShiftOp[] {
  const groups = new Map<string, IpPlanningGridRow[]>();
  for (const r of rows) {
    if (r.is_aggregate) continue;
    const g = key(r.sku_style ?? r.sku_code, r.sku_color);
    let bucket = groups.get(g);
    if (!bucket) { bucket = []; groups.set(g, bucket); }
    bucket.push(r);
  }

  const ops: BuyerShiftOp[] = [];
  for (const bucket of groups.values()) {
    // Index existing rows by period_start; map old Buyer by period_start.
    const byStart = new Map<string, IpPlanningGridRow>();
    for (const r of bucket) byStart.set(r.period_start, r);
    const template = bucket[0];

    // Target months = every existing month (to clear sources) PLUS the prior
    // month of every month that currently carries a Buyer qty (the landing
    // spots — which may not have a row yet).
    const targets = new Set<string>();
    for (const r of bucket) {
      targets.add(r.period_start);
      if ((r.buyer_request_qty ?? 0) !== 0) {
        targets.add(monthOffset(r.period_start, 1).period_start); // prior month
      }
    }

    for (const q of targets) {
      const next = monthOffset(q, -1); // one month AFTER q
      const incoming = byStart.get(next.period_start);
      const newBuyer = incoming?.buyer_request_qty ?? 0;
      const existing = byStart.get(q);
      const currentBuyer = existing?.buyer_request_qty ?? 0;
      if (newBuyer === currentBuyer) continue;              // no change
      if (!existing && newBuyer === 0) continue;            // nothing to create
      const qp = existing ? { period_start: existing.period_start, period_code: existing.period_code, period_end: existing.period_end }
                          : monthOffset(next.period_start, 1); // rebuild the q period tokens
      ops.push({
        period_start: qp.period_start,
        period_code: qp.period_code,
        period_end: qp.period_end,
        style_code: template.sku_style ?? template.sku_code,
        color: template.sku_color ?? "TBD",
        new_buyer: newBuyer,
        existing_tbd_id: existing?.tbd_id,
        template,
      });
    }
  }
  return ops;
}

/**
 * Orchestrator for a multi-customer shift. planBuyerShiftBackOneMonth groups
 * only by (style, color) and assumes ONE schedule, so two customers that share
 * a style/color would collide (their same-month rows overwrite in the planner's
 * period map). Group by customer first, plan each customer independently, then
 * concatenate — each op keeps its own template.customer_id + existing_tbd_id so
 * the caller's apply stays customer-correct.
 */
export function planBuyerShiftBackForCustomers(rows: IpPlanningGridRow[]): BuyerShiftOp[] {
  const byCustomer = new Map<string, IpPlanningGridRow[]>();
  for (const r of rows) {
    if (r.is_aggregate) continue;
    const cid = r.customer_id ?? r.customer_name ?? "";
    let bucket = byCustomer.get(cid);
    if (!bucket) { bucket = []; byCustomer.set(cid, bucket); }
    bucket.push(r);
  }
  return Array.from(byCustomer.values()).flatMap((custRows) => planBuyerShiftBackOneMonth(custRows));
}
