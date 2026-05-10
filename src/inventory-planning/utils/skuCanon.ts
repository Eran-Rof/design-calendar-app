// src/inventory-planning/utils/skuCanon.ts
//
// Browser-side mirror of api/_lib/sku-canon.js. Used by the Excel
// uploader so SKU normalization stays in lock-step with the API
// handlers (xoro-sales-sync, tanda-pos-sync, ats-supply-sync).
// If you change the regex or any helper here, change it in the .js
// file too — tests should catch drift.

// Covers numeric (-30), single-letter (-XS..-XXXL), 2-letter (-SM/-LG),
// 3-letter (-SML/-MED/-XLG/-XXLG/-XXXLG/-XSM), digit-prefixed XL family
// generalized as [0-9]*X+LG? (catches -2XL/-3XLG and the bare -XL/-XLG),
// one-size (-OS/-OSFA/-O/S), prepack (-PPK18/-PPK_24), and parenthesized
// ranges (-L(14-16)).
export const SIZE_SUFFIX_RE =
  /-(XS|XSM|S|SM|M|MD|L|LG|[0-9]*X+LG?|SML|MED|LRG|OS|OSFA|O\/S|PPK[\s_-]*\d+|[0-9]+|[A-Z]+\([0-9X\-]+\))$/;

export function canonSku(raw: string | null | undefined): string {
  return (raw ?? "").toString().trim().toUpperCase().replace(/\s+/g, "");
}

export function canonStyleColor(raw: string | null | undefined): string {
  const s = canonSku(raw);
  return s ? s.replace(SIZE_SUFFIX_RE, "") : s;
}

export function parseStyleColor(canonicalSku: string | null | undefined): { style: string | null; color: string | null } {
  if (!canonicalSku) return { style: null, color: null };
  const dash = canonicalSku.indexOf("-");
  if (dash <= 0) return { style: canonicalSku, color: null };
  return {
    style: canonicalSku.substring(0, dash),
    color: canonicalSku.substring(dash + 1),
  };
}
