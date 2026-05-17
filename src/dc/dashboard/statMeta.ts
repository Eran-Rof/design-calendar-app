// Visual configuration for the four dashboard stat filters
// (overdue / week / 30d / collections). Lifted out of DashboardPanel
// so the panel doesn't carry the same 30-line literal in its render
// closure on every render. Tasks are NOT included here — those stay
// derived inside the panel via the selectors. Combine config + tasks
// at the call site.

import { TH } from "../styles";

export type StatFilterKey = "overdue" | "week" | "30d" | "collections";

export interface StatMetaConfig {
  label:  string;
  color:  string;
  bg:     string;
  bdr:    string;
  accent: string;
}

export const STAT_META_CONFIG: Record<StatFilterKey, StatMetaConfig> = {
  overdue: {
    label:  "Overdue Tasks",
    color:  "#B91C1C",
    bg:     "#FEF2F2",
    bdr:    "#FCA5A5",
    accent: "#FC8181",
  },
  week: {
    label:  "Due This Week",
    color:  "#B45309",
    bg:     "#FFFBEB",
    bdr:    "#FCD34D",
    accent: "#F6AD55",
  },
  "30d": {
    label:  "Due in Next 30 Days",
    color:  "#1D4ED8",
    bg:     "#EFF6FF",
    bdr:    "#BFDBFE",
    accent: "#63B3ED",
  },
  collections: {
    label:  "All Collections",
    color:  TH.primary,
    bg:     TH.accent,
    bdr:    TH.accentBdr,
    accent: TH.primary,
  },
};
