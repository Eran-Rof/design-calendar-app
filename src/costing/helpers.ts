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

// Palette mirrors STATUS_CONFIG in src/utils/constants.ts so badges match
// the visual language of ATS / Tanda / Design Calendar.
const STATUS_COLOR: Record<CostingStatus, { bg: string; fg: string; border: string }> = {
  draft:       { bg: "#F3F4F6", fg: "#6B7280", border: "#D1D5DB" }, // Not Started gray
  in_progress: { bg: "#FFFBEB", fg: "#B45309", border: "#FCD34D" }, // In Progress amber
  quoted:      { bg: "#F5F3FF", fg: "#6D28D9", border: "#C4B5FD" }, // Review purple
  awarded:     { bg: "#ECFDF5", fg: "#065F46", border: "#6EE7B7" }, // Approved green
  closed:      { bg: "#D1FAE5", fg: "#047857", border: "#34D399" }, // Complete green
  cancelled:   { bg: "#FEF2F2", fg: "#B91C1C", border: "#FCA5A5" }, // Delayed red
};

export function statusLabel(s: CostingStatus): string { return STATUS_LABEL[s] || s; }
export function statusColor(s: CostingStatus) { return STATUS_COLOR[s] || STATUS_COLOR.draft; }

export const ALL_STATUSES: CostingStatus[] = [
  "draft", "in_progress", "quoted", "awarded", "closed", "cancelled",
];

// URL helpers for the query-string sub-routing inside /costing.
export type CostingViewName = "list" | "edit" | "settings" | "rfq-list" | "rfq-edit";

export function getView(): CostingViewName {
  if (typeof window === "undefined") return "list";
  const v = new URLSearchParams(window.location.search).get("view");
  if (v === "edit") return "edit";
  if (v === "settings") return "settings";
  if (v === "rfq-list") return "rfq-list";
  if (v === "rfq-edit") return "rfq-edit";
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
