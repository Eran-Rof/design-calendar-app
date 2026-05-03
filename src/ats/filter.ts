import type { ATSRow } from "./types";
import { fmtDate, displayColor } from "./helpers";

export interface RowFilterOpts {
  search: string;
  filterCategory: string;
  filterSubCategory: string;
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

// Normalize a string for case-/whitespace-tolerant equality. Real upload
// data sometimes has "rof" / "ROF " / "  PT" instead of "ROF" / "PT" — the
// filter dropdowns use the canonical form, but exact-match comparisons
// dropped legitimate rows. Normalize both sides on every check.
function normForCompare(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

export function filterRows(rows: ATSRow[], opts: RowFilterOpts): ATSRow[] {
  const tokens = tokenizeSearch(opts.search);
  const todayKey = fmtDate(opts.today);
  // Pre-normalize the filter selections once.
  const wantStore = opts.storeFilter.includes("All")
    ? null
    : new Set(opts.storeFilter.map(normForCompare));
  const wantGender = opts.filterGender === "All" ? null : normForCompare(opts.filterGender);
  return rows.filter(r => {
    if (!rowMatchesSearch(r, tokens)) return false;
    // Category filter pulls from master_category (the truth) with a fallback
    // to legacy r.category so rows from older code paths still filter sanely
    // — at 100% master coverage the fallback is unused.
    if (opts.filterCategory !== "All") {
      const cat = r.master_category ?? r.category ?? "";
      if (cat !== opts.filterCategory) return false;
    }
    if (opts.filterSubCategory !== "All") {
      if ((r.master_sub_category ?? "") !== opts.filterSubCategory) return false;
    }
    if (wantGender !== null && normForCompare(r.gender) !== wantGender) return false;
    const todayQty = r.dates[todayKey] ?? r.onHand;
    if (opts.filterStatus !== "All") {
      if (opts.filterStatus === "Out" && !(todayQty <= 0)) return false;
      if (opts.filterStatus === "Low" && !(todayQty > 0 && todayQty <= 10)) return false;
      if (opts.filterStatus === "InStock" && !(todayQty > 10)) return false;
    }
    if (opts.minATS !== "" && todayQty < opts.minATS) return false;
    if (wantStore !== null && !wantStore.has(normForCompare(r.store ?? "ROF"))) return false;
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
    else if (sortCol === "category")    { av = a.master_category    ?? ""; bv = b.master_category    ?? ""; }
    else if (sortCol === "subCategory") { av = a.master_sub_category ?? ""; bv = b.master_sub_category ?? ""; }
    else if (sortCol === "style")       { av = a.master_style       ?? ""; bv = b.master_style       ?? ""; }
    else if (sortCol === "color")       { av = displayColor(a);            bv = displayColor(b); }
    else if (sortCol === "onHand")      { av = a.onHand;      bv = b.onHand; }
    else if (sortCol === "onOrder")  { av = a.onOrder; bv = b.onOrder; }
    else if (sortCol === "onPO")     { av = a.onPO;    bv = b.onPO;   }
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
