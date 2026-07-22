// api/_lib/purchasedResolve.js
//
// Per-BUCKET "Purchased" preference for the Inventory Matrix (snapshot column +
// its drill). "Purchased" = physical units purchased/received. Two feeds carry
// it and OVERLAP for every Xoro-world PO:
//   • receipts  — ip_receipts_history (the Xoro receipts mirror, #1747, 07-14):
//                 the authoritative UNIT feed wherever it exists.
//   • bills     — invoice_line_items of vendor_bill / vendor_credit_memo (the AP
//                 bills-register, added 06-28): the FINANCIAL leg.
// When BOTH exist for the same goods the bucket double-counts (receipts often
// land on a color-level size-NULL SKU while the bill lands on the sized SKUs of
// the SAME (style,color) bucket — so this preference MUST be resolved per bucket,
// never per SKU, or the two legs of one bucket still add together).
//
// Rule: receipts win where they exist; the vendor-bill total only BACKSTOPS
// buckets the receipts feed does not cover (bills-only native flows, pre-Aug-2024
// history). Pure + side-effect-free so it is unit-testable and shared by the
// snapshot aggregate and the drill so the column and the popup always agree.

/**
 * Resolve a bucket's Purchased quantity from its two feed totals.
 * @param {number} receiptsTotal  Σ receipts qty for the (style,color) bucket (post PPK explosion).
 * @param {number} billTotal      Σ vendor-bill/credit qty for the same bucket (post PPK explosion).
 * @returns {number} receiptsTotal when it is > 0, else billTotal (bill fallback).
 */
export function resolvePurchased(receiptsTotal, billTotal) {
  const r = Number(receiptsTotal) || 0;
  const b = Number(billTotal) || 0;
  return r > 0 ? r : b;
}

/**
 * Which feed a bucket's Purchased should be drawn from — so the drill can show
 * receipt documents when the column counted receipts, and vendor bills only when
 * it fell back. Mirrors resolvePurchased exactly.
 * @param {number} receiptsTotal
 * @returns {"receipts"|"bills"} "receipts" when receiptsTotal > 0, else "bills".
 */
export function purchasedSource(receiptsTotal) {
  return (Number(receiptsTotal) || 0) > 0 ? "receipts" : "bills";
}
