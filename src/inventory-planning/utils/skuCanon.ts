// src/inventory-planning/utils/skuCanon.ts
//
// Browser-side mirror of api/_lib/sku-canon.js. Used by the Excel
// uploader so SKU normalization stays in lock-step with the API
// handlers (xoro-sales-sync, tanda-pos-sync, ats-supply-sync).
// If you change the regex or any helper here, change it in the .js
// file too — tests should catch drift.

export const SIZE_SUFFIX_RE =
  /-(XS|XSM|S|SM|M|MD|L|LG|XL|XLG|XXL|XXLG|XXXL|XXXLG|SML|MED|LRG|OS|OSFA|O\/S|[0-9]+|[A-Z]+\([0-9X\-]+\))$/;

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
