// Grid-level constants shared between the Grid component and any
// utility module that needs the canonical option list / default
// collapse state.

import type { CollapseModes } from "./types";

// Multi-select dropdown options for the collapse selector. The
// dropdown stays open across selections so the planner can flick
// on combinations (e.g. customers + colors). applyCollapseKeys
// enforces the runtime invariants (category vs subCat exclusive,
// wide rollups override simple customers/colors).
export const COLLAPSE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "customers",                  label: "All customers (per style/color)" },
  { value: "colors",                     label: "All colors per style" },
  { value: "customerAllStyles",          label: "All styles per customer" },
  { value: "allCustomersPerStyle",       label: "All customers per style" },
  { value: "allCustomersPerCategory",    label: "All customers per category" },
  { value: "allCustomersPerSubCat",      label: "All customers per sub cat" },
  { value: "category",                   label: "By category" },
  { value: "subCat",                     label: "By sub cat" },
];

export const NO_COLLAPSE: CollapseModes = {
  customers: false, colors: false, category: false, subCat: false,
  customerAllStyles: false, allCustomersPerCategory: false,
  allCustomersPerSubCat: false, allCustomersPerStyle: false,
};
