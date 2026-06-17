// Pure helpers extracted from GridView.tsx. No React, no DOM — safe
// to import from unit tests.

import {
  HIDEABLE_COL_KEYS,
  COL_WIDTHS,
  PHASE_SUB,
} from "./constants";

/** Normalise any date string Xoro might return into YYYY-MM-DD.
 *  Handles: "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD", "MM/DD/YYYY", etc.
 *  Returns "" if the string is empty or unparseable. */
export function normDateISO(d?: string): string {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{4}-\d{2}-\d{2}T/.test(d)) return d.slice(0, 10);
  const dt = new Date(d);
  if (!isNaN(dt.getTime())) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
  return "";
}

/** Build the grid-template-columns string for the fixed (non-phase) tracks. */
export function buildFixedColsTpl(hidden: Set<string>): string {
  const parts = ["32px", "32px"]; // chevron + notes
  for (const k of HIDEABLE_COL_KEYS) parts.push(hidden.has(k) ? "0px" : COL_WIDTHS[k]);
  return parts.join(" ");
}

/** Full grid-template-columns: fixed + N phase strips of PHASE_SUB. */
export function buildColTpl(phaseCount: number, hiddenCols: Set<string>) {
  const fixed = buildFixedColsTpl(hiddenCols);
  return phaseCount > 0
    ? `${fixed} ${Array(phaseCount).fill(PHASE_SUB).join(" ")}`
    : fixed;
}

// ── Style/Color grouping helpers ─────────────────────────────────────────

export function isSizeToken(s: string): boolean {
  const t = s.trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return false;
  // Alpha sizes incl. XXS, one-size synonyms, and full-word forms — matches the
  // size vocabulary in api/_lib/sizeScaleMatch.js so grouping strips every real
  // size (a missed size leaves the row grouped down to size instead of color).
  if (/^(XXS|2XS|XS|XSM|XSML|XSMALL|S|SM|SML|SMALL|M|MED|MEDIUM|L|LG|LRG|LARGE|XL|XLG|XLRG|XLARGE|XXL|2XL|XXLARGE|2XLARGE|XXXL|3XL|XXXXL|4XL|5XL|6XL|OS|OSFA|ONESIZE)$/.test(t)) return true;
  if (/^\d{1,3}(\.5)?$/.test(t)) return true;     // numeric sizes (6, 8, 32, 34, 10.5 …)
  if (/^\d{1,3}[WLR]$/.test(t)) return true;      // waist/length suffixed: 32W, 34L, 30R
  if (/^[1-6]X$/.test(t)) return true;            // women's plus: 1X–6X
  if (/^\d{1,2}T$/.test(t)) return true;          // toddler: 2T–16T
  if (/^\d{1,2}M$/.test(t)) return true;          // infant months: 3M, 12M, 24M
  if (/^\d{1,2}-\d{1,2}M$/.test(t)) return true;  // infant month ranges: 0-3M, 6-12M
  if (/^Y(XS|S|M|L|XL)$/.test(t)) return true;    // youth alpha: YS, YM, YL …
  return false;
}

/** Returns the style+color portion of an item number (strips trailing size segment). */
export function styleColorKey(itemNumber: string, description: string): string {
  if (!itemNumber) return description || "";
  const parts = itemNumber.split("-");
  if (parts.length > 1 && isSizeToken(parts[parts.length - 1])) {
    return parts.slice(0, -1).join("-");
  }
  return itemNumber;
}

/** Returns the size label from an item number, or "" if none detected. */
export function itemSizeLabel(itemNumber: string): string {
  if (!itemNumber) return "";
  const parts = itemNumber.split("-");
  if (parts.length > 1 && isSizeToken(parts[parts.length - 1])) return parts[parts.length - 1].trim();
  return "";
}

/** Sort size strings: numeric first (ascending), then alpha sizes in standard order, then lexicographic. */
export function sizeSort(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  const ORDER: Record<string, number> = { XS: 0, S: 1, SM: 1, Small: 1, M: 2, Medium: 2, L: 3, Large: 3, XL: 4, Xlarge: 4, XXL: 5, "2XL": 5, "3XL": 6, "4XL": 7, "5XL": 8, "6XL": 9 };
  const oa = ORDER[a.toUpperCase()] ?? ORDER[a];
  const ob = ORDER[b.toUpperCase()] ?? ORDER[b];
  if (oa !== undefined && ob !== undefined) return oa - ob;
  if (oa !== undefined) return -1;
  if (ob !== undefined) return 1;
  return a.localeCompare(b);
}
