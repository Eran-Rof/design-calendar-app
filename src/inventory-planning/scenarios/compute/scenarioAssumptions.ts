// Pure assumption-application functions. Each takes a forecast row
// shape and a list of assumptions that might apply to it, and returns
// the modified row. Keeping them pure means the service layer can
// exercise every path in tests without IO.
//
// Matching rules:
//   • sku-specific assumptions win over category-scoped which win over
//     customer/channel-scoped which win over global (null scope).
//   • Period filter is inclusive: an assumption without period_start
//     applies to every period; one with period_start applies only when
//     period_start matches exactly.
//   • When multiple assumptions of the same type match a row, ALL of
//     them are applied in scope-specificity order (specific last).
//     Numeric stacks by addition/multiplication per the type below.

import type {
  IpAssumptionType,
  IpScenarioAssumption,
} from "../types/scenarios";
import type { IpWholesaleForecast } from "../../types/wholesale";
import type { IpEcomForecast } from "../../ecom/types/ecom";

// ── scope match ────────────────────────────────────────────────────────────
export interface ScopeKeys {
  customer_id?: string | null;
  channel_id?: string | null;
  category_id?: string | null;
  sku_id: string;
  period_start: string;
}

// Is the row in-scope for this assumption? An assumption is in-scope when
// every non-null "applies_to_*" field matches the row.
export function scopeMatches(a: IpScenarioAssumption, row: ScopeKeys): boolean {
  if (a.applies_to_sku_id && a.applies_to_sku_id !== row.sku_id) return false;
  if (a.applies_to_category_id && a.applies_to_category_id !== (row.category_id ?? null)) return false;
  if (a.applies_to_customer_id && a.applies_to_customer_id !== (row.customer_id ?? null)) return false;
  if (a.applies_to_channel_id && a.applies_to_channel_id !== (row.channel_id ?? null)) return false;
  if (a.period_start && a.period_start !== row.period_start) return false;
  return true;
}

// How "specific" an assumption is — higher wins when multiple match.
export function specificityRank(a: IpScenarioAssumption): number {
  let r = 0;
  if (a.applies_to_sku_id) r += 8;
  if (a.applies_to_category_id) r += 4;
  if (a.applies_to_customer_id) r += 2;
  if (a.applies_to_channel_id) r += 2;
  if (a.period_start) r += 1;
  return r;
}

export function filterApplicable(
  assumptions: IpScenarioAssumption[],
  row: ScopeKeys,
  type: IpAssumptionType,
): IpScenarioAssumption[] {
  return assumptions
    .filter((a) => a.assumption_type === type && scopeMatches(a, row))
    .sort((a, b) => specificityRank(a) - specificityRank(b));
}

// ── wholesale forecast row adjustments ────────────────────────────────────
export function applyAssumptionsToWholesaleRow(
  row: IpWholesaleForecast,
  assumptions: IpScenarioAssumption[],
): IpWholesaleForecast {
  const scope: ScopeKeys = {
    customer_id: row.customer_id,
    category_id: row.category_id,
    sku_id: row.sku_id,
    period_start: row.period_start,
  };
  let system = row.system_forecast_qty;
  let buyer = row.buyer_request_qty;
  let override = row.override_qty;

  // demand_uplift_percent — multiplicative on system_forecast_qty
  for (const a of filterApplicable(assumptions, scope, "demand_uplift_percent")) {
    const pct = (a.assumption_value ?? 0) / 100;
    system = Math.max(0, Math.round(system * (1 + pct)));
  }
  // override_qty — signed delta; specific overrides replace, so we apply
  // the most-specific one (last in the sorted list).
  const overrideMatches = filterApplicable(assumptions, scope, "override_qty");
  if (overrideMatches.length > 0) {
    const last = overrideMatches[overrideMatches.length - 1];
    override = Math.round(last.assumption_value ?? 0);
  }

  const final_forecast_qty = Math.max(0, system + buyer + override);
  return { ...row, system_forecast_qty: system, override_qty: override, final_forecast_qty };
}

// ── ecom forecast row adjustments ────────────────────────────────────────
export function applyAssumptionsToEcomRow(
  row: IpEcomForecast,
  assumptions: IpScenarioAssumption[],
): IpEcomForecast {
  const scope: ScopeKeys = {
    channel_id: row.channel_id,
    category_id: row.category_id,
    sku_id: row.sku_id,
    period_start: row.week_start,
  };
  let system = row.system_forecast_qty;
  let override = row.override_qty;
  let promoFlag = row.promo_flag;
  let markdownFlag = row.markdown_flag;
  let protectedQty = row.protected_ecom_qty;

  for (const a of filterApplicable(assumptions, scope, "demand_uplift_percent")) {
    const pct = (a.assumption_value ?? 0) / 100;
    system = Math.max(0, Math.round(system * (1 + pct)));
  }
  // promo_flag / markdown_flag: 1 means on, 0 means off.
  for (const a of filterApplicable(assumptions, scope, "promo_flag")) {
    promoFlag = (a.assumption_value ?? 0) > 0;
  }
  for (const a of filterApplicable(assumptions, scope, "markdown_flag")) {
    markdownFlag = (a.assumption_value ?? 0) > 0;
  }
  // protection_percent — set protected = final * (value%).
  const overrideMatches = filterApplicable(assumptions, scope, "override_qty");
  if (overrideMatches.length > 0) {
    override = Math.round(overrideMatches[overrideMatches.length - 1].assumption_value ?? 0);
  }
  const final_forecast_qty = Math.max(0, system + override);

  const protMatches = filterApplicable(assumptions, scope, "protection_percent");
  if (protMatches.length > 0) {
    const pct = Math.min(1, Math.max(0, (protMatches[protMatches.length - 1].assumption_value ?? 0) / 100));
    protectedQty = Math.round(final_forecast_qty * pct);
  } else {
    protectedQty = final_forecast_qty; // MVP Phase 2 policy
  }

  return {
    ...row,
    system_forecast_qty: system,
    override_qty: override,
    final_forecast_qty,
    protected_ecom_qty: protectedQty,
    promo_flag: promoFlag,
    markdown_flag: markdownFlag,
  };
}

// ── open-PO date shift (receipt_delay_days) ───────────────────────────────
export function applyReceiptDelayToDate(
  iso: string | null,
  days: number,
): string | null {
  if (!iso) return iso;
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── reserve_qty_override for allocation rules ─────────────────────────────
// Returns the override qty for a (customer, sku) pair, if any
// reserve_qty_override assumption applies.
export function reserveQtyOverrideFor(
  assumptions: IpScenarioAssumption[],
  customerId: string | null,
  categoryId: string | null,
  skuId: string,
): number | null {
  const scope: ScopeKeys = {
    customer_id: customerId,
    category_id: categoryId,
    sku_id: skuId,
    period_start: "",
  };
  const matches = assumptions
    .filter((a) => a.assumption_type === "reserve_qty_override")
    .filter((a) => {
      if (a.applies_to_sku_id && a.applies_to_sku_id !== scope.sku_id) return false;
      if (a.applies_to_category_id && a.applies_to_category_id !== (scope.category_id ?? null)) return false;
      if (a.applies_to_customer_id && a.applies_to_customer_id !== (scope.customer_id ?? null)) return false;
      return true;
    })
    .sort((a, b) => specificityRank(a) - specificityRank(b));
  if (matches.length === 0) return null;
  return matches[matches.length - 1].assumption_value ?? null;
}
