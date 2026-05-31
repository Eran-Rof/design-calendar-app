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

// ── Date defaults for new costing projects ────────────────────────────────
// Operator ask: when creating a project, prefill the three header dates.
//   request_date  = today
//   due_date      = +5 business days from request_date (skip Sat/Sun)
//   projected_delivery_date = +120 calendar days from due_date, snapped
//                              DOWN to the 1st of that month
// All dates are ISO YYYY-MM-DD in local time. We work in UTC internally
// to avoid the off-by-one that hits when local time crosses midnight.

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function addBusinessDays(iso: string, n: number): string {
  const d = parseIso(iso);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return toIso(d);
}

export function addCalendarDays(iso: string, n: number): string {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

export function snapToMonthStart(iso: string): string {
  const d = parseIso(iso);
  d.setUTCDate(1);
  return toIso(d);
}

/** Build the three default project dates per the operator's rule. */
export function defaultProjectDates(today: string = todayIso()) {
  const request_date = today;
  const due_date = addBusinessDays(request_date, 5);
  const projected_delivery_date = snapToMonthStart(addCalendarDays(due_date, 120));
  return { request_date, due_date, projected_delivery_date };
}
