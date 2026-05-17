// Shared types extracted from WholesalePlanningGrid.tsx + Workbench.
// Keeping them in a tiny module so other extracted helpers + the
// (still-large) main components can all import the same definitions
// without re-declaring them.

import type { CollapseModes as ExtractedCollapseModes } from "../aggregateGridRows";

// Every column is sortable via header click. Click toggles asc/desc on
// the same key; clicking a different column resets to asc.
export type SortKey =
  | "category" | "subCat" | "style" | "color" | "description" | "customer"
  | "period" | "class" | "histT3" | "histLY" | "system" | "buyer" | "override" | "final"
  | "confidence" | "method" | "onHand" | "onSo" | "receipts" | "histRecv" | "ats"
  | "buy" | "avgCost" | "unitCost" | "buyDollars" | "shortage" | "excess" | "action";

// Re-export of the type defined alongside the aggregate logic in
// ./aggregateGridRows.ts. Kept as a local alias so existing references
// (CollapseModes) compile without churn.
export type CollapseModes = ExtractedCollapseModes;

// Workbench-level tab routing.
export type TabKey = "grid" | "requests";
