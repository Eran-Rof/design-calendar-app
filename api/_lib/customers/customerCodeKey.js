// Canonical customer_code key helpers.
//
// Legacy EXCEL:/ATS: import codes are the customer name uppercased with ALL
// whitespace stripped (e.g. "Brig Surf Shop" -> "EXCEL:BRIGSURFSHOP"). This
// mirrors canonSku() in src/inventory-planning/utils/skuCanon.ts, which the
// browser Excel ingest uses. Any importer that mints a customer_code MUST use
// the same space-stripped form, or its onConflict=customer_code upsert forks a
// duplicate customer off the existing row (the 2026-07-02 dupe merge cleaned up
// 25 such rows minted as "EXCEL:BRIG SURF SHOP" — space-collapsed, not stripped).

/** Uppercase + strip ALL whitespace. Punctuation is preserved (matches the
 *  legacy codes, e.g. "CSX Corp." -> "CSXCORP."). */
export function canonCodeKey(raw) {
  return String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

/** Reduce a stored customer_code to its bare comparison key: drop the source
 *  prefix then strip whitespace, so "EXCEL:BRIGSURFSHOP" and a legacy-forked
 *  "EXCEL:BRIG SURF SHOP" both collapse to "BRIGSURFSHOP". */
export function codeBareKey(code) {
  return canonCodeKey(String(code ?? "").replace(/^(EXCEL|ATS|XORO):/i, ""));
}
