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

// ── Receipt-row enrichment from the matching vendor bill ────────────────────
// The receipts feed is unit-authoritative but DOCUMENT-POOR: it has no unit
// price, its vendor_id points at ip_vendor_master (empty in prod), and it has
// no bill date. When the drill lists receipt rows it must still show the
// COMMERCIAL detail — vendor, unit price, bill date, clickable bill ref — which
// lives on the suppressed vendor bill for the same PO. These helpers index the
// bill rows and pick the best match for a receipt row.

/**
 * Index finalized bill rows for receipt enrichment.
 * @param {Array<{po_number?:string|null,color?:string|null,vendor?:string|null,
 *                unit_price?:number|null,bill_date?:string|null,bill_id?:string|null,
 *                ref?:string|null}>} billRows
 * @returns {{byPoColor:Map<string,object>, byColor:Map<string,object[]>}}
 *   byPoColor: `${po}|${color}` → the bill row (latest bill_date wins on dupes).
 *   byColor:   `${color}` → all bill rows for that colour.
 */
export function buildBillInfoIndex(billRows) {
  const byPoColor = new Map();
  const byColor = new Map();
  for (const b of billRows || []) {
    if (!b) continue;
    const ck = b.color ?? "";
    if (!byColor.has(ck)) byColor.set(ck, []);
    byColor.get(ck).push(b);
    if (b.po_number) {
      const k = `${b.po_number}|${ck}`;
      const cur = byPoColor.get(k);
      if (!cur || String(b.bill_date || "") > String(cur.bill_date || "")) byPoColor.set(k, b);
    }
  }
  return { byPoColor, byColor };
}

/**
 * Pick the bill whose commercial detail should decorate a receipt row.
 * Exact (po_number, color) match wins; else the colour's SINGLE bill (an
 * unambiguous colour-level match); else null (never guess between bills).
 * @param {{po_number?:string|null,color?:string|null}} receipt
 * @param {{byPoColor:Map<string,object>, byColor:Map<string,object[]>}} index
 * @returns {object|null}
 */
export function pickBillInfoFor(receipt, index) {
  if (!receipt || !index) return null;
  const ck = receipt.color ?? "";
  if (receipt.po_number) {
    const hit = index.byPoColor.get(`${receipt.po_number}|${ck}`);
    if (hit) return hit;
  }
  const list = index.byColor.get(ck) || [];
  return list.length === 1 ? list[0] : null;
}
