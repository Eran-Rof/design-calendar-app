// Palette remap for the Excel-export preview modal. The downloaded
// .xlsx keeps its Excel-native colors (the planner spent ~20 iterations
// tuning that palette). The on-screen preview, however, reads better
// when it matches the rest of the app — so we walk every cell, look up
// the Excel hex code in this table, and substitute the equivalent
// `TH.*` token before rendering.
//
// Mapping is intentionally semantic, not chromatic — e.g. the Excel
// "low stock" yellow becomes the app's red-tinted accent because the
// app's red is the strongest "attention" signal in TH, just as yellow
// was in Excel. Hex codes are stored without the leading "#" to match
// the XLSXStyle convention `s.fill.fgColor.rgb`.
//
// Source palette → TH equivalents:
//   1F497D  HEADER_DARK   →  2D3748  TH.header
//   3278CC  HEADER_TEXT   →  4A5568  TH.textSub2
//   4081D0  HEADER_ONHAND →  1A202C  TH.text
//   EEF3FA  ZEBRA_EVEN    →  F7F8FA  TH.surfaceHi
//   FFFFFF  ZEBRA_ODD     →  FFFFFF  TH.surface       (unchanged)
//   B4C7E7  QTY_BAND      →  FFF5F5  TH.accent
//   FFEB9C  LOW_STOCK_BG  →  FEB2B2  TH.accentBdr
//   7F6000  LOW_STOCK_FG  →  C8210A  TH.primary
//   B0BAC9  PPK_TEXT      →  718096  TH.textMuted
//   FFE699  totals yellow →  FFF5F5  TH.accent
//
// Domain-color rows from individual exporters (Neg-Inven red, Stock-Vs-
// SO triage colors, Aged-Inven cost-group bands, etc.) are intentionally
// NOT remapped — operators rely on the semantic meaning of those colors
// (green = stock fill, red = needs PO, blue band = interest cost, etc.).
// They get the unmapped-hex passthrough below.

const RAW_MAP: Record<string, string> = {
  // ── Shared theme palette (every ATS export pulls from these) ────────
  "1F497D": "2D3748", // HEADER_DARK → TH.header
  "3278CC": "4A5568", // HEADER_TEXT → TH.textSub2
  "4081D0": "1A202C", // HEADER_ONHAND → TH.text
  "EEF3FA": "F7F8FA", // ZEBRA_EVEN → TH.surfaceHi
  "FFFFFF": "FFFFFF", // ZEBRA_ODD → TH.surface (identity)
  "B4C7E7": "FFF5F5", // QTY_BAND → TH.accent
  "FFEB9C": "FEB2B2", // LOW_STOCK_BG → TH.accentBdr
  "7F6000": "C8210A", // LOW_STOCK_FG → TH.primary
  "B0BAC9": "718096", // PPK_TEXT → TH.textMuted
  // ── exportExcel.ts ad-hoc accents that should pick up the app skin ──
  "FFE699": "FFF5F5", // Totals row yellow → TH.accent
};

// Normalize input: accept "#abc123" or "abc123" or lowercase, return
// uppercase 6-char hex (no #). Returns null when the input isn't a
// recognizable hex code so the caller can fall back to the raw value.
function normalizeHex(input: string): string | null {
  if (!input) return null;
  let s = input.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toUpperCase();
}

/**
 * Translate an Excel-export hex color to its app-theme equivalent.
 * Returns the original hex (normalized to uppercase, no `#`) when the
 * input isn't in the mapping table, so unknown / domain-specific colors
 * (Neg-Inven red, Aged-Inven cost-group bands, Stock-vs-SO triage
 * colors) flow through unchanged.
 */
export function mapExcelToAppPalette(excelHex: string): string {
  const key = normalizeHex(excelHex);
  if (!key) return excelHex;
  return RAW_MAP[key] ?? key;
}
