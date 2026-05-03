// Color resolution for forecast/grid rows. Identifying dimensions —
// color, size, sku — must come from the variant itself, never from the
// style-master row. Falling back to the style master tags every color-
// less variant with the master's arbitrary color (e.g. all 31 RYB0412
// variants becoming "Grey"), which then corrupts the All-sizes / All-
// colors collapse buckets in the wholesale grid.
//
// Resolution order:
//   1. variant.color when present and non-blank
//   2. parsed suffix of sku_code after `${style_code}-`
//      (e.g. "RYB0412-NAVY" -> "NAVY")
//   3. null — explicit, so the grid renders "(no color)" rather than
//      silently grouping unrelated variants together.

export function parseColorFromSkuCode(
  skuCode: string | null | undefined,
  styleCode: string | null | undefined,
): string | null {
  if (!skuCode || !styleCode) return null;
  const prefix = `${styleCode}-`;
  if (!skuCode.startsWith(prefix)) return null;
  const rest = skuCode.slice(prefix.length).trim();
  return rest.length > 0 ? rest : null;
}

// Color-word vocabulary used to break a concatenated upper-case suffix
// like "TONALGREYCAMO" into "Tonal Grey Camo". Listed long-first so the
// alternation greedy-matches longer tokens before shorter ones (e.g.
// "GRIZZLY" wins before "GREY"). Add new tokens here as the master
// expands — the parser silently passes through unknown chunks rather
// than guessing.
const COLOR_TOKENS = [
  "ESPRESSO", "SHIITAKE", "CHARCOAL", "BURGUNDY", "WOODLAND",
  "ROASTED", "GRIZZLY",
  "AUTUMN", "MARINE", "CASHEW", "WALNUT", "SAHARA", "WITHER",
  "ASHEN", "BLACK", "BROWN", "GREEN", "KHAKI", "CREAM", "TONAL",
  "OLIVE", "WHITE", "NIGHT",
  "GREY", "GOLD", "NAVY", "DULL", "CAMO", "FADE",
  "BLK", "LT",
];
const COLOR_TOKEN_ALIASES: Record<string, string> = {
  BLK: "Black",
  LT: "Lt",
};
const COLOR_TOKEN_REGEX = new RegExp(`(${COLOR_TOKENS.join("|")})`, "g");

function titleWord(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

// Pretty-prints an inferred color string. "TONALGREYCAMO" -> "Tonal Grey
// Camo". Tokens not in the vocabulary fall through title-cased as a
// single chunk, so unknown words still render readably (e.g. "RUSSET"
// -> "Russet"). Whitespace and underscores in the input are flattened
// since the inferred-from-sku-code path never carries them anyway.
export function prettifyColorCode(raw: string): string {
  const upper = raw.toUpperCase().replace(/[\s_]+/g, "");
  if (!upper) return raw;
  const parts: string[] = [];
  let last = 0;
  COLOR_TOKEN_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COLOR_TOKEN_REGEX.exec(upper)) !== null) {
    if (m.index > last) parts.push(titleWord(upper.slice(last, m.index)));
    const tok = m[0];
    parts.push(COLOR_TOKEN_ALIASES[tok] ?? titleWord(tok));
    last = m.index + tok.length;
  }
  if (last < upper.length) parts.push(titleWord(upper.slice(last)));
  return parts.join(" ").trim();
}

export function resolveVariantColor(
  variantColor: string | null | undefined,
  skuCode: string | null | undefined,
  styleCode: string | null | undefined,
): string | null {
  const own = variantColor && variantColor.trim().length > 0 ? variantColor.trim() : null;
  return own ?? parseColorFromSkuCode(skuCode, styleCode);
}

// Same resolution but also reports whether the color came from the
// variant's own master field (false) or was inferred from the sku_code
// suffix (true). Callers stamp the flag onto forecast rows so the grid
// can render a "⚠ inferred" hint, surfacing the upstream data gap
// without hiding it. Inferred colors are also prettified through the
// vocabulary so "TONALGREYCAMO" lands as "Tonal Grey Camo" rather than
// the raw upper-case suffix.
export function resolveVariantColorWithProvenance(
  variantColor: string | null | undefined,
  skuCode: string | null | undefined,
  styleCode: string | null | undefined,
): { color: string | null; inferred: boolean } {
  const own = variantColor && variantColor.trim().length > 0 ? variantColor.trim() : null;
  if (own) return { color: own, inferred: false };
  const parsed = parseColorFromSkuCode(skuCode, styleCode);
  if (parsed == null) return { color: null, inferred: false };
  return { color: prettifyColorCode(parsed), inferred: true };
}
