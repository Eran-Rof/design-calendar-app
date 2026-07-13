// Unified column metadata for the Wholesale Planning grid.
//
// One source of truth for: which columns the planner can freeze on,
// which can be toggled hidden, the human labels for every column, and
// the width-compute configuration (per-col CAP/FLOOR + global PADDING).
//
// Originally these tables lived inside WholesalePlanningGrid.tsx —
// FREEZE_LABELS, TOGGLEABLE_COLUMNS, GENDER_LABELS, and the CAP/FLOOR/
// LABEL trio inside the dynamicColWidths useMemo all repeated themselves
// every render AND restated the same column labels in three places.
// Pulling them out kills the allocation churn and gives Th-style cell
// renderers a stable import path.

// ── Freeze ───────────────────────────────────────────────────────────

// Order MUST match the DOM render order of the leftmost columns — the
// sticky-freeze CSS maps nth-child(i+1) ⇄ FREEZABLE_COLS[i]. Inseam is
// rendered between Color and Customer, so it sits there here too.
export const FREEZABLE_COLS = [
  "category", "subCat", "style", "description", "color", "inseam", "customer", "period",
] as const;

export type FreezeKey = typeof FREEZABLE_COLS[number];

export const FREEZE_LABELS: Record<FreezeKey, string> = {
  category: "Category", subCat: "Sub Cat", style: "Style", description: "Description",
  color: "Color", inseam: "Inseam", customer: "Customer", period: "Period",
};

// ── Gender ───────────────────────────────────────────────────────────

export const GENDER_LABELS: Record<string, string> = {
  M:   "Mens",
  C:   "Child",
  B:   "Boys",
  WMS: "Womens",
  G:   "Girls",
};

export function genderLabel(code: string): string {
  return GENDER_LABELS[code] ?? code;
}

// ── Toggleable columns + label map ───────────────────────────────────

export const TOGGLEABLE_COLUMNS: Array<{ key: string; label: string }> = [
  { key: "category",    label: "Category" },
  { key: "subCat",      label: "Sub Cat" },
  { key: "style",       label: "Style" },
  { key: "description", label: "Description" },
  { key: "color",       label: "Color" },
  { key: "inseam",      label: "Inseam" },
  { key: "customer",    label: "Customer" },
  { key: "period",      label: "Period" },
  { key: "class",       label: "Class" },
  { key: "histT3",      label: "Hist T3" },
  { key: "histLY",      label: "SP/LY" },
  { key: "margin",      label: "Margin %" },
  { key: "system",      label: "System" },
  { key: "buyer",       label: "Buyer" },
  { key: "override",    label: "Override" },
  { key: "final",       label: "Final" },
  { key: "confidence",  label: "Conf." },
  { key: "method",      label: "Method" },
  { key: "onHand",      label: "On hand" },
  { key: "onSo",        label: "On SO" },
  { key: "receipts",    label: "Receipts" },
  { key: "histRecv",    label: "Hist Recv" },
  { key: "ats",         label: "ATS" },
  { key: "buy",         label: "Buy" },
  { key: "avgCost",     label: "Avg Cost" },
  { key: "unitCost",    label: "Unit Cost" },
  { key: "buyDollars",  label: "Buy $" },
  { key: "shortage",    label: "Short" },
  { key: "excess",      label: "Excess" },
  { key: "action",      label: "Action" },
];

// Reverse lookup for the column-label-by-key pattern the width compute
// (and any header / tooltip renderer) needs. Built from TOGGLEABLE_COLUMNS
// so adding a column in one place updates both.
export const COLUMN_LABEL: Record<string, string> = Object.fromEntries(
  TOGGLEABLE_COLUMNS.map(c => [c.key, c.label]),
);

// ── Column width compute config ──────────────────────────────────────

// Safe avg pixel width per character at 11–12px mixed sans/mono.
export const COL_WIDTH_CHAR_PX = 7.4;
// ~2 chars on each side of content.
export const COL_WIDTH_PADDING_CHARS = 4;
// Hard minimum width — keeps the narrowest text columns clickable.
export const COL_WIDTH_FLOOR_PX = 44;

// Per-column caps — stop one outlier (very long description, etc.)
// from blowing the row width.
export const COL_WIDTH_CAP: Record<string, number> = {
  // customer cap is generous enough to fit a long customer name PLUS the
  // planner-added-row controls (Add to DB + ✕) that computeContentLengths
  // reserves for — otherwise the buttons spill into the Period column.
  description: 320, customer: 360, color: 200, style: 160,
  subCat: 160, category: 160, method: 160,
};

// Per-column floors — numeric edit inputs need room for their intrinsic
// width regardless of content. Without this, columns like "buyer" would
// collapse to 44px and clip the spin buttons.
export const COL_WIDTH_FLOOR: Record<string, number> = {
  system: 84, buyer: 84, override: 84, buy: 84,
  unitCost: 88, avgCost: 84, buyDollars: 92,
  confidence: 84, action: 96, period: 84, inseam: 64,
};
