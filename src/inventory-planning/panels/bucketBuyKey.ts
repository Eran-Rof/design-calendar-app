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
  // (colors / customers don't add named dims beyond what the SKU /
  // style + period already imply — bucket buys aren't meaningful for
  // those modes alone, so we still build a key but it's narrowly
  // scoped to the period.)

  // Filter-scoped dims (only applied when not already captured above):
  if (filters.customer_id && custId == null) custId = filters.customer_id;
  if (filters.group_name && groupName == null) groupName = filters.group_name;
  if (filters.sub_category_name && subCategoryName == null) subCategoryName = filters.sub_category_name;
  if (filters.gender) gender = filters.gender;

  const period = row.period_code;
  const bucket_key = [
    `mode=${mode}`,
    `cust=${custId ?? "-"}`,
    `cat=${groupName ?? "-"}`,
    `sub=${subCategoryName ?? "-"}`,
    `gen=${gender ?? "-"}`,
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
