import type { ATSRow } from "./types";
import { fmtDate } from "./helpers";

export interface RowFilterOpts {
  search: string;
  filterCategory: string;
  filterGender: string;
  filterStatus: string;
  minATS: number | "";
  storeFilter: string[];
  customerSkuSet: Set<string> | null;
  today: Date;
}

// Splits the search string into whitespace-delimited tokens and returns true
// only if every token appears in the sku or description. Exported so callers
// can reuse it for other filter surfaces (customer dropdown, etc.).
export function tokenizeSearch(search: string): string[] {
  return search.trim().toLowerCase().split(/\s+/).filter(t => t && t !== "-");
}

export function rowMatchesSearch(row: ATSRow, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const sku  = (row.sku         ?? "").toLowerCase();
  const desc = (row.description ?? "").toLowerCase();
  return tokens.every(t => sku.includes(t) || desc.includes(t));
}

export function filterRows(rows: ATSRow[], opts: RowFilterOpts): ATSRow[] {
  const tokens = tokenizeSearch(opts.search);
  const todayKey = fmtDate(opts.today);
  return rows.filter(r => {
    if (!rowMatchesSearch(r, tokens)) return false;
    if (opts.filterCategory !== "All" && r.category !== opts.filterCategory) return false;
    if (opts.filterGender !== "All" && (r.gender ?? "") !== opts.filterGender) return false;
    const todayQty = r.dates[todayKey] ?? r.onHand;
    if (opts.filterStatus !== "All") {
      if (opts.filterStatus === "Out" && !(todayQty <= 0)) return false;
      if (opts.filterStatus === "Low" && !(todayQty > 0 && todayQty <= 10)) return false;
      if (opts.filterStatus === "InStock" && !(todayQty > 10)) return false;
    }
    if (opts.minATS !== "" && todayQty < opts.minATS) return false;
    if (!opts.storeFilter.includes("All") && !opts.storeFilter.includes(r.store ?? "ROF")) return false;
    if (opts.customerSkuSet && !opts.customerSkuSet.has(r.sku)) return false;
    return true;
  });
}

// Stat-card filter — shows only rows matching the active stat in ANY period
// column. No-op when no stat is selected.
export function statFilterRows(
  rows: ATSRow[],
  activeSort: string | null,
  displayPeriods: Array<{ endDate: string }>,
): ATSRow[] {
  if (!activeSort) return rows;
  if (activeSort === "negATS") {
    return rows.filter(r => displayPeriods.some(p => {
      const q = r.dates[p.endDate];
      return q != null && q < 0;
    }));
  }
  if (activeSort === "zeroStock") {
    return rows.filter(r => displayPeriods.some(p => {
      const q = r.dates[p.endDate];
      return q != null && q <= 0;
    }));
  }
  if (activeSort === "lowStock") {
    return rows.filter(r => displayPeriods.some(p => {
      const q = r.dates[p.endDate];
      return q != null && q > 0 && q <= 10;
    }));
  }
  return rows;
}

// Column-header sort. Returns a new sorted array; input is not mutated.
export function sortRows(
  rows: ATSRow[],
  sortCol: string | null,
  sortDir: "asc" | "desc",
): ATSRow[] {
  if (!sortCol) return rows;
  return [...rows].sort((a, b) => {
    let av: string | number;
    let bv: string | number;
    if      (sortCol === "sku")         { av = a.sku;         bv = b.sku; }
    else if (sortCol === "description") { av = a.description; bv = b.description; }
    else if (sortCol === "onHand")      { av = a.onHand;      bv = b.onHand; }
    else if (sortCol === "onOrder")     { av = a.onCommitted; bv = b.onCommitted; }
    else if (sortCol === "onPO")        { av = a.onOrder;     bv = b.onOrder; }
    else                                { av = a.dates[sortCol] ?? 0; bv = b.dates[sortCol] ?? 0; }
    if (typeof av === "string") {
      return sortDir === "asc"
        ? av.localeCompare(bv as string)
        : (bv as string).localeCompare(av);
    }
    return sortDir === "asc"
      ? (av as number) - (bv as number)
      : (bv as number) - (av as number);
  });
}
