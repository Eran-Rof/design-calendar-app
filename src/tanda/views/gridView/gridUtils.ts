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

// Alpha-synonym map (matches api/_lib/sizeScaleMatch.js) so different spellings
// of the same size collapse: "LRG"/"LARGE" → "L", "12MO" → "12M", etc. Used to
// reconcile the raw Xoro item-number tokens against the canonical Tangerine
// size-scale tokens.
const ALPHA_SYNONYM: Record<string, string> = {
  XSM: "XS", XSML: "XS", XSMALL: "XS",
  SM: "S", SML: "S", SMALL: "S",
  MED: "M", MEDIUM: "M",
  LG: "L", LRG: "L", LARGE: "L",
  XLG: "XL", XLRG: "XL", XLARGE: "XL",
  XXL: "2XL", XXLARGE: "2XL", "2XLARGE": "2XL",
  XXXL: "3XL", "3XLARGE": "3XL", XXXXL: "4XL",
  ONESIZE: "OS", OSFA: "OS", "O/S": "OS",
};

/** Normalise a raw size token to a canonical comparable form. */
export function normSizeToken(raw: string): string {
  const t = String(raw ?? "").toUpperCase().trim().replace(/\s+/g, "");
  if (!t) return "";
  // Month spellings: 12MO / 12MOS / 12MONTH(S) → 12M (the scale's spelling).
  const mo = t.match(/^(\d{1,2})M(?:O|OS|ONTH|ONTHS)?$/);
  if (mo) return `${mo[1]}M`;
  return ALPHA_SYNONYM[t] ?? t;
}

/** Build the canonical size vocabulary from the Tangerine size_scales rows
 *  (every size + inseam across all scales, normalised). Passed into the grid
 *  grouping so size detection follows the actual scales, not a fixed list. */
export function buildSizeVocab(scales: { sizes?: string[] | null; inseams?: string[] | null }[]): Set<string> {
  const v = new Set<string>();
  for (const s of scales || []) {
    for (const z of [...(s.sizes || []), ...(s.inseams || [])]) {
      const n = normSizeToken(z);
      if (n) v.add(n);
    }
  }
  return v;
}

/** Is `s` a size token? Checks the live Tangerine size-scale vocabulary first
 *  (when provided), then a structural fallback that covers the common forms so
 *  detection still works before the vocab loads / if a spelling drifts. */
export function isSizeToken(s: string, vocab?: Set<string>): boolean {
  const t = s.trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return false;
  if (vocab && vocab.size > 0 && vocab.has(normSizeToken(t))) return true;
  // Alpha sizes incl. XXS, one-size synonyms, and full-word forms.
  if (/^(XXS|2XS|XS|XSM|XSML|XSMALL|S|SM|SML|SMALL|M|MED|MEDIUM|L|LG|LRG|LARGE|XL|XLG|XLRG|XLARGE|XXL|2XL|XXLARGE|2XLARGE|XXXL|3XL|XXXXL|4XL|5XL|6XL|OS|OSFA|ONESIZE)$/.test(t)) return true;
  if (/^\d{1,3}(\.5)?$/.test(t)) return true;     // numeric sizes (6, 8, 32, 34, 10.5 …)
  if (/^\d{1,3}[WLR]$/.test(t)) return true;      // waist/length suffixed: 32W, 34L, 30R
  if (/^[1-6]X$/.test(t)) return true;            // women's plus: 1X–6X
  if (/^\d{1,2}T$/.test(t)) return true;          // toddler: 2T–16T
  if (/^\d{1,2}MO?S?$/.test(t)) return true;      // infant months: 3M, 12M, 12MO, 18MO …
  if (/^\d{1,2}-\d{1,2}MO?S?$/.test(t)) return true; // month ranges: 0-3M, 6-12M
  if (/^Y(XS|S|M|L|XL)$/.test(t)) return true;    // youth alpha: YS, YM, YL …
  if (/^PPK\d+$/.test(t)) return true;            // prepack token: PPK24, PPK48 …
  return false;
}

/** Returns the style+color portion of an item number (strips the size).
 *  Handles two layouts:
 *   1. Parenthesised sizes that contain a dash — "STYLE-COLOR-S(7-8)" — where a
 *      naive "-" split would shatter the size into "S(7" + "8)". The size begins
 *      at the first segment (after the style) that contains "(", so everything
 *      before it is style+color. (Mirrors xoroSkuToExcel in ats/helpers.ts.)
 *   2. A plain trailing size token — "STYLE-COLOR-32W" / "STYLE-COLOR-LRG". */
export function styleColorKey(itemNumber: string, description: string, vocab?: Set<string>): string {
  if (!itemNumber) return description || "";
  const parts = itemNumber.split("-");
  if (parts.length <= 1) return itemNumber;
  const parenIdx = parts.slice(1).findIndex((p) => p.includes("("));
  if (parenIdx !== -1) return parts.slice(0, parenIdx + 1).join("-"); // size starts at the "(" segment
  if (isSizeToken(parts[parts.length - 1], vocab)) return parts.slice(0, -1).join("-");
  return itemNumber;
}

/** Returns the size label from an item number, or "" if none detected.
 *  Paren-aware: "STYLE-COLOR-S(7-8)" → "S(7-8)" (the whole parenthesised size). */
export function itemSizeLabel(itemNumber: string, vocab?: Set<string>): string {
  if (!itemNumber) return "";
  const parts = itemNumber.split("-");
  if (parts.length <= 1) return "";
  const parenIdx = parts.slice(1).findIndex((p) => p.includes("("));
  if (parenIdx !== -1) return parts.slice(parenIdx + 1).join("-").trim();
  if (isSizeToken(parts[parts.length - 1], vocab)) return parts[parts.length - 1].trim();
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
