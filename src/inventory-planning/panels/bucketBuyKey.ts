// Deterministic bucket-key construction for collapsed-row Buy
// quantities. The key encodes:
//   - which collapse mode is active (so the same dim slice keyed
//     differently across modes doesn't accidentally collide)
//   - the row's dimension values that the collapse rolled up to
//   - any active filters that scope the rollup further
//
// A buy entered while the grid is in one configuration only re-
// surfaces when that same configuration is reconstituted. Different
// view = different key = different bucket. That's intentional —
// bucket buys are scoped to the slice the planner had on screen
// when they typed.

import type { IpPlanningGridRow } from "../types/wholesale";
import type { CollapseModes } from "./aggregateGridRows";

export interface BucketKeyFilters {
  customer_id: string | null;
  group_name: string | null;
  sub_category_name: string | null;
  gender: string | null;
}

// Pick the single collapse-mode label that best describes the active
// rollup. customerAllStyles wins over the others (it's the primary
// per-customer mode); category and subCat are mutually exclusive
// with all other modes already.
export function activeCollapseMode(modes: CollapseModes): string | null {
  if (modes.customerAllStyles) return "customerAllStyles";
  if (modes.allCustomersPerStyle) return "allCustomersPerStyle";
  if (modes.allCustomersPerCategory) return "allCustomersPerCategory";
  if (modes.allCustomersPerSubCat) return "allCustomersPerSubCat";
  if (modes.subCat) return "subCat";
  if (modes.category) return "category";
  if (modes.colors && modes.customers) return "colors+customers";
  if (modes.colors) return "colors";
  if (modes.customers) return "customers";
  return null;
}

// Returns the deterministic bucket_key string for an aggregate row.
// Returns null when the row isn't an aggregate (per-cell save path
// should be used instead).
export function bucketKeyFor(
  row: IpPlanningGridRow,
  modes: CollapseModes,
  filters: BucketKeyFilters,
): {
  bucket_key: string;
  collapse_mode: string;
  // Dimensions captured into the structural columns. Null when the
  // dimension isn't constrained for this bucket (e.g. customer_id is
  // null when collapse=category and no customer filter is set).
  customer_id: string | null;
  group_name: string | null;
  sub_category_name: string | null;
  gender: string | null;
  period_code: string;
} | null {
  if (!row.is_aggregate) return null;
  const mode = activeCollapseMode(modes);
  if (!mode) return null;

  // Determine which dims this bucket constrains. Start from the
  // collapse mode's keyed dimensions, then add any filter-scoped
  // dimensions that aren't already part of the collapse.
  let custId: string | null = null;
  let groupName: string | null = null;
  let subCategoryName: string | null = null;
  let gender: string | null = null;

  // Collapse-keyed dims:
  if (mode === "customerAllStyles") custId = row.customer_id ?? null;
  if (mode === "category") groupName = row.group_name ?? null;
  if (mode === "subCat") subCategoryName = row.sub_category_name ?? null;
  // The "all customers per …" modes constrain by the rolled-up category
  // dim but leave customer null — the bucket's whole point is that all
  // customers share the buy.
  if (mode === "allCustomersPerCategory") groupName = row.group_name ?? null;
  if (mode === "allCustomersPerSubCat") subCategoryName = row.sub_category_name ?? null;

  // Filter-scoped dims (only applied when not already captured above):
  if (filters.customer_id && custId == null) custId = filters.customer_id;
  if (filters.group_name && groupName == null) groupName = filters.group_name;
  if (filters.sub_category_name && subCategoryName == null) subCategoryName = filters.sub_category_name;
  if (filters.gender) gender = filters.gender;

  // Style + color identity for the row. Always included in the key so
  // each visible aggregate has a unique bucket — without these, two
  // style aggregates in the same period (e.g. "all customers per
  // style") would collide on `mode|cust=*|...|period=2025-05` and a
  // Buy typed on one would surface on every other style in that
  // period (the "Buy copying to next row" symptom). For category /
  // subCat modes that intentionally aggregate ACROSS styles, the
  // row's sku_style is null/synthetic so this still scopes correctly.
  const styleKey = mode === "category" || mode === "subCat" ? "-" : (row.sku_style ?? row.sku_code ?? "-");
  // sku_color is dropped from the key when the collapse explicitly
  // rolls up colors (mode = "colors" / "colors+customers" /
  // "allCustomersPerStyle"), so the bucket still spans every color of
  // the style. Otherwise color is part of the row's identity.
  const collapsesColors = mode === "colors" || mode === "colors+customers" || mode === "allCustomersPerStyle" || mode === "category" || mode === "subCat";
  const colorKey = collapsesColors ? "-" : (row.sku_color ?? "-");

  const period = row.period_code;
  const bucket_key = [
    `mode=${mode}`,
    `cust=${custId ?? "-"}`,
    `cat=${groupName ?? "-"}`,
    `sub=${subCategoryName ?? "-"}`,
    `gen=${gender ?? "-"}`,
    `style=${styleKey}`,
    `color=${colorKey}`,
    `period=${period}`,
  ].join("|");
  return {
    bucket_key,
    collapse_mode: mode,
    customer_id: custId,
    group_name: groupName,
    sub_category_name: subCategoryName,
    gender,
    period_code: period,
  };
}
