export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export function fmtDateShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateDisplay(dateStr: string): string {
  if (!dateStr) return "—";

  // ISO YYYY-MM-DD — anchor to local midnight to avoid timezone drift
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const d = new Date(dateStr + "T00:00:00");
    if (!isNaN(d.getTime()))
      return `${String(d.getMonth() + 1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;
  }

  // Numeric slash/dot formats that may arrive if stored value bypassed toIsoDate
  const slashDot = dateStr.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (slashDot) {
    const A = parseInt(slashDot[1], 10), B = parseInt(slashDot[2], 10);
    const y = parseInt(slashDot[3], 10);
    // If A > 12 it must be the day (DD/MM/YYYY); otherwise assume US MM/DD/YYYY
    const month = A > 12 ? B : A;
    const day   = A > 12 ? A : B;
    return `${String(month).padStart(2,"0")}/${String(day).padStart(2,"0")}/${y}`;
  }

  // Fallback: let the JS parser try
  const d = new Date(dateStr);
  if (!isNaN(d.getTime()))
    return `${String(d.getMonth() + 1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;

  return dateStr;
}

export function fmtDateHeader(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return `${day}\n${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function isToday(iso: string): boolean {
  return iso === fmtDate(new Date());
}

export function isWeekend(iso: string): boolean {
  const d = new Date(iso + "T00:00:00");
  const day = d.getDay();
  return day === 0 || day === 6;
}

export function getQtyColor(qty: number): string {
  if (qty <= 0) return "#EF4444";
  if (qty <= 10) return "#F59E0B";
  if (qty <= 50) return "#3B82F6";
  return "#10B981";
}

export function getQtyBg(qty: number): string {
  if (qty <= 0) return "rgba(239,68,68,0.15)";
  if (qty <= 10) return "rgba(245,158,11,0.15)";
  if (qty <= 50) return "rgba(59,130,246,0.12)";
  return "rgba(16,185,129,0.1)";
}

/** Normalize SKU string: collapse multiple spaces, standardize dash spacing, title case color names.
 *  "RYB059430PPK - Bark  -  Grey w Tint" → "RYB059430PPK - Bark - Grey w Tint"
 *  "RYB0412 - ESPRESSO" → "RYB0412 - Espresso"  */
export function normalizeSku(sku: string): string {
  // 1. Collapse all whitespace runs to single space
  let s = sku.replace(/\s+/g, " ").trim();
  // 2. Standardize dash spacing: only when hyphen has adjacent whitespace,
  //    so bare hyphens in style codes (RBB0185-03) are preserved.
  s = s.replace(/\s+-\s*|\s*-\s+/g, " - ");
  // 3. Title-case the color/wash portion (everything after first " - ")
  const firstDash = s.indexOf(" - ");
  if (firstDash >= 0) {
    const base = s.slice(0, firstDash); // keep base part as-is (e.g. RYB059430PPK)
    let rest = s.slice(firstDash + 3); // color portion
    // Standardize common wash/color abbreviations before title-casing
    rest = rest.replace(/\bmd\b/gi, "Med")
               .replace(/\blt\b/gi, "Lt")
               .replace(/\bdk\b/gi, "Dk");
    const titleCased = rest.replace(/\b\w+/g, (word) => {
      // Keep small connector words lowercase: w, of
      const lower = word.toLowerCase();
      const smallWords = new Set(["w", "of"]);
      if (smallWords.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
    s = base + " - " + titleCased;
  }
  return s;
}

/** Color string to render in the ATS grid's Color column.
 *
 *  Master is truth for category/sub-cat/style, but master_color is often null
 *  (most ATS rows match via the style fallback, which prefers the no-color
 *  base record). The actual variant color lives in the ATS SKU string, after
 *  the first " - ". Use master's color when sku-level matched (rare),
 *  otherwise parse from the SKU.  */
export function displayColor(row: { sku: string; master_color?: string | null; master_match_source?: "sku" | "style" | null }): string {
  if (row.master_match_source === "sku" && row.master_color) return row.master_color;
  const dash = row.sku.indexOf(" - ");
  if (dash === -1) return row.master_color ?? "";
  return row.sku.slice(dash + 3).trim();
}

// Common apparel color-word abbreviations → canonical form. The PIM
// (product_images.color) tends to spell colors out ("Black Camo") while the
// Xoro inventory (ip_item_master.color) abbreviates ("Blk Camo"), so a raw
// lowercase compare misses. Expanding both sides to a canonical token list
// lets the per-color image match. Spelling variants (grey→gray) included.
const COLOR_ABBREV: Record<string, string> = {
  blk: "black", blck: "black", wht: "white",
  gry: "gray", grey: "gray", chrcl: "charcoal", char: "charcoal",
  nvy: "navy", brn: "brown", brwn: "brown", grn: "green", blu: "blue",
  ylw: "yellow", yel: "yellow", org: "orange", pnk: "pink",
  prpl: "purple", ppl: "purple", lt: "light", dk: "dark", drk: "dark",
  htr: "heather", hthr: "heather", nat: "natural", olv: "olive",
};

/** Canonicalize a color name for matching: lowercase, split on any non-
 *  alphanumeric run, expand known abbreviations, re-join. "Blk Camo" and
 *  "Black Camo" both become "black camo". */
export function normalizeColor(c: string | null | undefined): string {
  return String(c ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => COLOR_ABBREV[w] ?? w)
    .join(" ");
}

/** Pick a per-color image URL from a style's byColor map, tolerant of the
 *  PIM-vs-inventory color-name spelling gap. Tries the exact lowercase key
 *  first (fast, no behavior change for already-matching colors), then a
 *  normalized match, then the style default / fallback. */
export function pickColorImage(
  byColor: Record<string, string> | undefined,
  color: string | null | undefined,
  fallback: string | null,
): string | null {
  if (byColor) {
    const raw = String(color ?? "").toLowerCase().trim();
    if (raw && byColor[raw]) return byColor[raw];
    const want = normalizeColor(color);
    if (want) {
      for (const k in byColor) {
        if (normalizeColor(k) === want) return byColor[k];
      }
    }
  }
  return fallback;
}

/** Dice-coefficient bigram similarity between two SKU strings (0–1).
 *  Normalizes both strings first, strips spaces/dashes for the comparison. */
export function skuSimilarity(a: string, b: string): number {
  const clean = (s: string) => normalizeSku(s).toLowerCase().replace(/[\s\-]/g, "");
  const s1 = clean(a);
  const s2 = clean(b);
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;
  const bigrams = (s: string) => Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2));
  const bg1 = bigrams(s1);
  const bg2 = bigrams(s2);
  const freqMap = new Map<string, number>();
  for (const bg of bg2) freqMap.set(bg, (freqMap.get(bg) ?? 0) + 1);
  let matches = 0;
  for (const bg of bg1) {
    const n = freqMap.get(bg) ?? 0;
    if (n > 0) { matches++; freqMap.set(bg, n - 1); }
  }
  return (2 * matches) / (bg1.length + bg2.length);
}

export function xoroSkuToExcel(rawSku: string): string {
  const parts = rawSku.split("-");
  if (parts.length < 2) return rawSku;
  // Sizes like "Xs(5-6)" contain a dash, so splitting naively yields multiple segments.
  // Detect the size start by finding the first segment (after index 0) that contains "(".
  const sizeIdx = parts.slice(1).findIndex(p => p.includes("("));
  if (sizeIdx !== -1) {
    const colorParts = parts.slice(1, sizeIdx + 1);
    return colorParts.length > 0 ? parts[0] + " - " + colorParts.join(" - ") : parts[0];
  }
  if (parts.length >= 3) return parts[0] + " - " + parts.slice(1, -1).join(" - ");
  return parts[0] + " - " + parts[1];
}
