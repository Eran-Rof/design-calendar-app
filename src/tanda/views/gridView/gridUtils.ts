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
  const t = s.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return false;
  if (/^(xs|s|sm|sml|small|m|med|medium|l|lg|lrg|large|xl|xlg|xlarge|xxl|2xl|xxxl|3xl|4xl|5xl|6xl)$/.test(t)) return true;
  if (/^\d{1,3}$/.test(t)) return true;   // numeric sizes (6, 8, 10, 32, 34 …)
  if (/^\d{1,3}[wlr]$/i.test(t)) return true; // 32W, 34L …
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
