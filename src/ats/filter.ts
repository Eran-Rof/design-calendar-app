import type { ATSRow } from "./types";
import { fmtDate, displayColor } from "./helpers";

export interface RowFilterOpts {
  search: string;
  // Multi-select. Empty array = no filter; otherwise the row must match
  // ONE of the listed categories (set membership). The legacy "All"
  // sentinel was dropped — callers pass [] for the unfiltered case.
  filterCategory: string[];
  // Multi-select on master_sub_category. Empty array = no filter.
  filterSubCategory: string[];
  // Multi-select on master_style. Empty array = no filter; otherwise the
  // row must match ONE of the listed styles (set membership).
  filterStyle: string[];
  // Multi-select on attributes.gender. Empty array = no filter; otherwise
  // the row's gender must be in the set (case-/whitespace-tolerant).
  filterGender: string[];
  // Multi-select on master_brand (the brand NAME resolved from
  // ip_item_master.brand_id). Optional + defaults to no filter so the
  // export / NavBar / test call sites that predate it keep working
  // without passing it.
  filterBrand?: string[];
  filterStatus: string;
  minATS: number | "";
  storeFilter: string[];
  customerSkuSet: Set<string> | null;
  today: Date;
  // Visible period columns the grid is rendering — used by the Min ATS
  // filter so it compares against the SAME per-period ATS qty the
  // operator sees in the leftmost period columns, not against today's
  // calendar-date qty (which can be empty when the picked startDate is
  // in the future). A row passes Min ATS if ANY visible period's qty
  // meets or exceeds the threshold (per operator spec 2026-05-26).
  // Optional: when omitted, Min ATS falls back to r.onHand only —
  // existing tests + callers that predate this prop keep working.
  displayPeriods?: Array<{ endDate: string }>;
}

// Splits the search string into whitespace-delimited tokens and returns true
// only if every token appears in the sku or description. Exported so callers
// can reuse it for other filter surfaces (customer dropdown, etc.).
export function tokenizeSearch(search: string): string[] {
  return search.trim().toLowerCase().split(/\s+/).filter(t => t && t !== "-");
}

// Plain "ppk" was generating false positives — "BARTRAM ZpPkt Tech
// Pant" lowercases to "bartram zppkt tech pant" and contains "ppk"
// as a substring (the two adjacent p's after Z + P merge to "pp"
// after toLowerCase). Same story for "wZipPkt".
//
// Distinguishing real prepack SKUs from those false positives:
// real SKUs have "PPK" either at the end of a word (RYB059430PPK,
// RYG1842PPK), or followed by digits (PPK24, PPK60). False
// positives have "ppk" followed by an extra letter ("t" in both
// cases). So the regex matches "ppk" NOT followed by a letter —
// end-of-string, digits, dashes, or whitespace are all fine.
//
// Earlier version of this fix required digits after PPK
// (/ppk[\s_-]*\d+/i) which mismatched the real-SKU shape and
// returned zero results for "ppk" searches.
const PPK_TOKEN_RE = /ppk(?![a-z])/i;

export function rowMatchesSearch(row: ATSRow, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const sku  = (row.sku         ?? "").toLowerCase();
  const desc = (row.description ?? "").toLowerCase();
  return tokens.every(t => {
    if (t === "ppk") return PPK_TOKEN_RE.test(sku) || PPK_TOKEN_RE.test(desc);
    return sku.includes(t) || desc.includes(t);
  });
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
  // PT ECOM is a sales-only channel sharing PT's physical inventory.
  // No PO/SO/inventory row carries store="PT ECOM", so filtering to it
  // alone would empty the grid. Treat PT ECOM as an alias for PT in the
  // row filter — sales totals still narrow to channel_id=PT ECOM via the
  // export's separate channel filter.
  if (wantStore && wantStore.has("PT ECOM")) {
    wantStore.add("PT");
  }
  const wantGender = opts.filterGender.length === 0
    ? null
    : new Set(opts.filterGender.map(normForCompare));
  // Brand filter compares on the resolved brand NAME. Empty / absent = no
  // filter. Names come from brand_master verbatim, so an exact-match Set
  // (no normalization) is correct.
  const wantBrand = !opts.filterBrand || opts.filterBrand.length === 0
    ? null
    : new Set(opts.filterBrand);
  // Empty array = no filter; otherwise build a set for O(1) membership.
  const wantCategory = opts.filterCategory.length === 0
    ? null
    : new Set(opts.filterCategory);
  const wantSubCategory = opts.filterSubCategory.length === 0
    ? null
    : new Set(opts.filterSubCategory);
  const wantStyle = opts.filterStyle.length === 0
    ? null
    : new Set(opts.filterStyle);
  return rows.filter(r => {
    if (!rowMatchesSearch(r, tokens)) return false;
    // Category filter pulls from master_category (the truth) with a fallback
    // to legacy r.category so rows from older code paths still filter sanely
    // — at 100% master coverage the fallback is unused.
    if (wantCategory !== null) {
      const cat = r.master_category ?? r.category ?? "";
      if (!wantCategory.has(cat)) return false;
    }
    if (wantSubCategory !== null) {
      if (!wantSubCategory.has(r.master_sub_category ?? "")) return false;
    }
    if (wantStyle !== null) {
      if (!wantStyle.has(r.master_style ?? "")) return false;
    }
    // Gender pulls from master_gender (the truth) with a fallback to the
    // feed's r.gender — the ATS upload's per-row Gender column is frequently
    // blank even when the item master knows the gender (e.g. RYB1477 = M).
    if (wantGender !== null && !wantGender.has(normForCompare(r.master_gender ?? r.gender))) return false;
    if (wantBrand !== null && !wantBrand.has(r.master_brand ?? "")) return false;
    const todayQty = r.dates[todayKey] ?? r.onHand;
    if (opts.filterStatus !== "All") {
      if (opts.filterStatus === "Out" && !(todayQty <= 0)) return false;
      if (opts.filterStatus === "Low" && !(todayQty > 0 && todayQty <= 10)) return false;
      if (opts.filterStatus === "InStock" && !(todayQty > 10)) return false;
    }
    // Min ATS — operator spec 2026-05-26: a row passes if ANY visible
    // period's ATS qty meets or exceeds the threshold. Scan
    // r.dates[periods[i].endDate] for every column the grid is rendering
    // (matches what the operator sees in the leftmost columns). r.onHand
    // is included as a safety fallback for rows that don't yet carry
    // per-period entries (e.g. early in load). Earlier behavior used
    // only today's calendar-date qty, which diverged from the grid when
    // startDate was in the future or the view was weekly/monthly.
    if (opts.minATS !== "") {
      const min = opts.minATS;
      let pass = false;
      if (opts.displayPeriods) {
        for (const p of opts.displayPeriods) {
          const q = r.dates[p.endDate];
          if (typeof q === "number" && q >= min) { pass = true; break; }
        }
      }
      if (!pass && typeof r.onHand === "number" && r.onHand >= min) pass = true;
      if (!pass) return false;
    }
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

// Rows with open PO or SO activity float above inert rows so the user's
// attention lands on lines that actually need watching. Applied as the
// PRIMARY sort key on top of any user-chosen column sort (and even when no
// column sort is active). Within each tier, the column sort (or input
// order, if no sortCol) wins. Native Array.sort is stable in modern JS.
export function hasOpenActivity(r: ATSRow): boolean {
  return r.onPO > 0 || r.onOrder > 0;
}

// Column-header sort. Returns a new sorted array; input is not mutated.
export function sortRows(
  rows: ATSRow[],
  sortCol: string | null,
  sortDir: "asc" | "desc",
): ATSRow[] {
  // If there's no user sort column, still bubble active rows to the top
  // and keep everything else in input order.
  if (!sortCol) {
    return [...rows].sort((a, b) => Number(hasOpenActivity(b)) - Number(hasOpenActivity(a)));
  }
  return [...rows].sort((a, b) => {
    // Primary: bubble active (PO/SO > 0) rows above inert ones.
    const actDiff = Number(hasOpenActivity(b)) - Number(hasOpenActivity(a));
    if (actDiff !== 0) return actDiff;
    // Secondary: user's column sort.
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
