// src/tanda/todayDrillFilters.ts
//
// Pure filter helpers for the Today page "drill to subset" wiring (follow-up to
// #1824/#1826). A Today to-do can carry a one-shot drill param that lands the
// target panel pre-filtered to exactly the subset the count refers to. The panel
// reads the param on mount and narrows its already-loaded rows with one of these
// pure predicates — extracted here so the exact selection logic is unit-testable
// without a DOM.
//
// House rule: dates are ISO `YYYY-MM-DD` strings. All comparisons use the DATE
// PART only (slice(0,10)) and lexicographic order, which is TZ-safe for that
// format. `today` is computed once by the caller and threaded in.

// ── date math (UTC-anchored so day arithmetic never drifts across DST) ───────
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);
const datePart = (d: string | null | undefined): string => (d ? String(d).slice(0, 10) : "");

// ═══════════════════════════════════════════════════════════════════════════
// Allocations Workbench — ?focus= (so.ship_due_7d / ship_overdue /
// factor_not_submitted). Mirrors the pack's server-side predicates on
// v_allocation_demand so the drilled subset ties to the to-do count.
// ═══════════════════════════════════════════════════════════════════════════

export type AllocationFocus = "ship_due" | "ship_overdue" | "factor_gate";

export type AllocFocusRow = {
  open_qty: number | string | null;
  requested_ship_date: string | null;
  is_factored?: boolean | null;
  factor_approval_status?: string | null;
  factor_reference?: string | null;
};

export function isAllocationFocus(v: string): v is AllocationFocus {
  return v === "ship_due" || v === "ship_overdue" || v === "factor_gate";
}

/** Does one demand row belong to the given focus subset (as of `today`)? */
export function matchesAllocationFocus(row: AllocFocusRow, focus: AllocationFocus, today: string): boolean {
  const open = num(row.open_qty) > 0;
  const ship = datePart(row.requested_ship_date);
  switch (focus) {
    case "ship_due":
      // open qty AND requested ship date within [today, today+7d] inclusive.
      return open && !!ship && ship >= today && ship <= addDaysISO(today, 7);
    case "ship_overdue":
      // open qty AND requested ship date already behind us.
      return open && !!ship && ship < today;
    case "factor_gate": {
      // factored, open, NOT fully factor-approved, shipping within 14 days.
      if (!row.is_factored || !open || !ship) return false;
      const approved =
        row.factor_approval_status === "approved" && String(row.factor_reference || "").trim() !== "";
      if (approved) return false;
      return ship <= addDaysISO(today, 14);
    }
    default:
      return false;
  }
}

export function filterAllocationFocus<T extends AllocFocusRow>(rows: T[], focus: AllocationFocus, today: string): T[] {
  return rows.filter((r) => matchesAllocationFocus(r, focus, today));
}

/** Banner copy for each focus (count injected by the caller). */
export function allocationFocusLabel(focus: AllocationFocus, n: number): string {
  const line = n === 1 ? "line" : "lines";
  switch (focus) {
    case "ship_due":
      return `Showing ${n.toLocaleString()} ${line} shipping in the next 7 days`;
    case "ship_overdue":
      return `Showing ${n.toLocaleString()} ${line} past their ship date`;
    case "factor_gate":
      return `Showing ${n.toLocaleString()} factored ${line} that still need factor approval`;
    default:
      return "";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3-Way Match — ?tw=exceptions (po.three_way_exceptions). The to-do counts
// vendor_invoice_drafts with three_way_match_status IN ('variance','exception');
// this narrows the loaded drafts to exactly those exception-grade statuses.
// ═══════════════════════════════════════════════════════════════════════════

export type ThreeWayDraftRow = { three_way_match_status?: string | null };
export const THREE_WAY_EXCEPTION_STATUSES = ["variance", "exception"] as const;

export function isThreeWayException(row: ThreeWayDraftRow): boolean {
  return (THREE_WAY_EXCEPTION_STATUSES as readonly string[]).includes(String(row.three_way_match_status || ""));
}

export function filterThreeWayExceptions<T extends ThreeWayDraftRow>(rows: T[]): T[] {
  return rows.filter(isThreeWayException);
}
