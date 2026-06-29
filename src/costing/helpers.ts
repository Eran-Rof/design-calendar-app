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

// Dark-slate palette tuned for the ATS / Tanda / Tangerine app shell
// (bg #0F172A, card #1E293B). Light-mode pastels were unreadable on the
// dark background, so each status uses a translucent dark fill + a bright
// foreground that reads against #0F172A / #1E293B.
const STATUS_COLOR: Record<CostingStatus, { bg: string; fg: string; border: string }> = {
  draft:       { bg: "#334155", fg: "#CBD5E1", border: "#475569" }, // Not Started slate
  in_progress: { bg: "#78350F33", fg: "#FBBF24", border: "#B45309" }, // In Progress amber
  quoted:      { bg: "#4C1D9533", fg: "#C4B5FD", border: "#6D28D9" }, // Review purple
  awarded:     { bg: "#064E3B33", fg: "#6EE7B7", border: "#047857" }, // Approved green
  closed:      { bg: "#065F4633", fg: "#34D399", border: "#059669" }, // Complete green
  cancelled:   { bg: "#7F1D1D33", fg: "#FCA5A5", border: "#B91C1C" }, // Delayed red
};

export function statusLabel(s: CostingStatus): string { return STATUS_LABEL[s] || s; }
export function statusColor(s: CostingStatus) { return STATUS_COLOR[s] || STATUS_COLOR.draft; }

export const ALL_STATUSES: CostingStatus[] = [
  "draft", "in_progress", "quoted", "awarded", "closed", "cancelled",
];

// URL helpers for the query-string sub-routing inside /costing.
export type CostingViewName = "list" | "edit" | "settings" | "rfq-list" | "rfq-edit" | "rfq-compare" | "messages";

export function getView(): CostingViewName {
  if (typeof window === "undefined") return "list";
  const sp = new URLSearchParams(window.location.search);
  // ?project=<id> is a deep-link into a specific project's edit view.
  // Row clicks on the RFQ list open the source project this way in a new tab.
  if (sp.get("project")) return "edit";
  const v = sp.get("view");
  if (v === "edit") return "edit";
  if (v === "settings") return "settings";
  if (v === "rfq-list") return "rfq-list";
  if (v === "rfq-edit") return "rfq-edit";
  if (v === "rfq-compare") return "rfq-compare";
  if (v === "messages") return "messages";
  return "list";
}

export function getEditId(): string | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  // ?project=<id> deep-link: treat the project id as the edit id.
  return sp.get("project") || sp.get("id");
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
