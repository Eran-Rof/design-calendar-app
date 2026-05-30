// Costing Module — helpers
//
// Re-exports the canonical date formatter and adds status display helpers.

import { fmtDateDisplay } from "../ats/helpers";
import type { CostingStatus } from "./types";

export { fmtDateDisplay };

const STATUS_LABEL: Record<CostingStatus, string> = {
  draft:       "Draft",
  in_progress: "In Progress",
  quoted:      "Quoted",
  awarded:     "Awarded",
  closed:      "Closed",
  cancelled:   "Cancelled",
};

const STATUS_COLOR: Record<CostingStatus, { bg: string; fg: string }> = {
  draft:       { bg: "#E5E7EB", fg: "#374151" },
  in_progress: { bg: "#DBEAFE", fg: "#1E40AF" },
  quoted:      { bg: "#FEF3C7", fg: "#92400E" },
  awarded:     { bg: "#DCFCE7", fg: "#166534" },
  closed:      { bg: "#E0E7FF", fg: "#3730A3" },
  cancelled:   { bg: "#FEE2E2", fg: "#991B1B" },
};

export function statusLabel(s: CostingStatus): string { return STATUS_LABEL[s] || s; }
export function statusColor(s: CostingStatus) { return STATUS_COLOR[s] || STATUS_COLOR.draft; }

export const ALL_STATUSES: CostingStatus[] = [
  "draft", "in_progress", "quoted", "awarded", "closed", "cancelled",
];

// URL helpers for the query-string sub-routing inside /costing.
export type CostingViewName = "list" | "edit" | "settings";

export function getView(): CostingViewName {
  if (typeof window === "undefined") return "list";
  const v = new URLSearchParams(window.location.search).get("view");
  if (v === "edit") return "edit";
  if (v === "settings") return "settings";
  return "list";
}

export function getEditId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("id");
}

export function navigate(view: CostingViewName, id?: string | null) {
  if (typeof window === "undefined") return;
  const sp = new URLSearchParams();
  sp.set("view", view);
  if (id) sp.set("id", id);
  const url = `/costing?${sp.toString()}`;
  window.history.pushState({}, "", url);
  // Trigger a custom event so the app re-renders without a full reload.
  window.dispatchEvent(new CustomEvent("costing:navigate"));
}
