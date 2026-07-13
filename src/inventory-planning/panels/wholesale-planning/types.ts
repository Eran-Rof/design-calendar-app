// Shared types extracted from WholesalePlanningGrid.tsx + Workbench.
// Keeping them in a tiny module so other extracted helpers + the
// (still-large) main components can all import the same definitions
// without re-declaring them.

import type { CollapseModes as ExtractedCollapseModes } from "../aggregateGridRows";

// Every column is sortable via header click. Plain click = single-column
// sort (toggles asc/desc/off); Shift+click adds the column as a secondary /
// tertiary sort key (a "child" of the columns already sorted), so the planner
// can e.g. sort by Customer, then Period within each customer.
export type SortKey =
  | "category" | "subCat" | "style" | "color" | "description" | "customer"
  | "period" | "class" | "histT3" | "histLY" | "system" | "buyer" | "override" | "final"
  | "confidence" | "method" | "onHand" | "onSo" | "receipts" | "histRecv" | "ats"
  | "buy" | "avgCost" | "unitCost" | "buyDollars" | "shortage" | "excess" | "action";

// One level of the multi-column sort stack. Stack order = priority: index 0 is
// the parent (primary) sort, later entries are children (tie-breakers).
export type SortEntry = { key: SortKey; dir: "asc" | "desc" };

// Re-export of the type defined alongside the aggregate logic in
// ./aggregateGridRows.ts. Kept as a local alias so existing references
// (CollapseModes) compile without churn.
export type CollapseModes = ExtractedCollapseModes;

// Workbench-level tab routing.
export type TabKey = "grid" | "requests";
