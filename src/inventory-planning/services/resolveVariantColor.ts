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

export function resolveVariantColor(
  variantColor: string | null | undefined,
  skuCode: string | null | undefined,
  styleCode: string | null | undefined,
): string | null {
  const own = variantColor && variantColor.trim().length > 0 ? variantColor.trim() : null;
  return own ?? parseColorFromSkuCode(skuCode, styleCode);
}
