// Normalize Xoro SoEstimate records into the ATSSoEvent shape the grid
// already understands. The Xoro response wraps each SO as
// { SoEstimateHeader: {…}, SoEstimateItemLineArr: [{…}, …] } — we
// flatten to one ATSSoEvent per line item, picking QtyRemainingToShip
// (open commitments only, not the originally-ordered total) so partially
// shipped lines don't double-count what's already left the warehouse.
//
// Field choice rationale:
//   - QtyRemainingToShip beats Qty/QtyOrdered: Released SOs include
//     partially-shipped lines, and ATS's "On SO" math wants the
//     unshipped balance, not the original commitment.
//   - DateToBeShipped (line) beats header.DateToBeShipped: Xoro lets
//     line-level ship dates diverge from the header (split shipments).
//     Fall back to header if the line is missing one.
//   - StoreName (clean, e.g. "Psycho Tuna") beats SaleStoreName
//     (prefixed, e.g. "Prebook - Psycho Tuna"): the prefixed variant
//     is operational metadata; the grid groups by base store name.

import type { ATSSoEvent } from "./types";

// Minimal subset of Xoro's record shape we actually consume. Xoro returns
// 100+ fields per header and dozens per line; locking the type here to
// just what the normalizer reads keeps this file independent from the
// full Xoro API surface.
interface XoroSoLine {
  ItemNumber?: string | null;
  QtyRemainingToShip?: number | string | null;
  Qty?: number | string | null;
  QtyOrdered?: number | string | null;
  UnitPrice?: number | string | null;
  LineAmount?: number | string | null;
  DateToBeShipped?: string | null;
  CancelDate?: string | null;
}
interface XoroSoHeader {
  OrderNumber?: string | null;
  CustomerFullName?: string | null;
  CustomerName?: string | null;
  StoreName?: string | null;
  SaleStoreName?: string | null;
  DateToBeShipped?: string | null;
  // Cancel date — when the SO auto-cancels if unshipped. Used by the
  // Sales Comps SO view's date filter so an SO with a Sept ship date
  // and a June cancel date still appears inside a "May → July" window.
  // Falls back to line-level CancelDate first, then header DateToBeShipped
  // for legacy uploads that pre-date the CancelDate trim (May 2026).
  CancelDate?: string | null;
  // Xoro labels the customer's PO inconsistently across endpoints —
  // cover the common variants. Surfaces in the right-click menu next
  // to the SO number when present.
  CustomerPONumber?: string | null;
  CustomerPoNumber?: string | null;
  CustomerPO?: string | null;
  CustomerPo?: string | null;
}
export interface XoroSoRecord {
  SoEstimateHeader: XoroSoHeader;
  SoEstimateItemLineArr?: XoroSoLine[];
}

// Xoro emits dates as US-format MM/DD/YYYY strings ("02/03/2025"). The
// grid keys by ISO YYYY-MM-DD, so we convert. Returns "" on anything we
// can't parse — the caller can drop those lines or surface them to the
// user.
function toIsoDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mm = m[1].padStart(2, "0");
    const dd = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  // Fallback for ISO-shaped inputs (in case Xoro changes format mid-flight).
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return "";
}

function toNum(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeXoroSos(records: XoroSoRecord[]): {
  events: ATSSoEvent[];
  skipped: { noSku: number; noDate: number; zeroQty: number };
} {
  const events: ATSSoEvent[] = [];
  let noSku = 0;
  let noDate = 0;
  let zeroQty = 0;

  for (const rec of records) {
    const h = rec?.SoEstimateHeader;
    const lines = Array.isArray(rec?.SoEstimateItemLineArr) ? rec.SoEstimateItemLineArr : [];
    if (!h || lines.length === 0) continue;

    const orderNumber = String(h.OrderNumber ?? "").trim();
    const customerName = String(h.CustomerFullName ?? h.CustomerName ?? "").trim();
    const customerPo = String(h.CustomerPONumber ?? h.CustomerPoNumber ?? h.CustomerPO ?? h.CustomerPo ?? "").trim();
    // StoreName is the canonical bare name; SaleStoreName carries the
    // sales-channel prefix that varies by department (Prebook, Psycho
    // Tuna, etc.). Use the bare name.
    const store = String(h.StoreName ?? h.SaleStoreName ?? "").trim();
    const headerDate = toIsoDate(h.DateToBeShipped);
    const headerCancelDate = toIsoDate(h.CancelDate);

    for (const ln of lines) {
      const sku = String(ln?.ItemNumber ?? "").trim();
      if (!sku) { noSku++; continue; }

      // QtyRemainingToShip = qty open. Falls back to QtyOrdered then Qty
      // for defensive coverage if Xoro response varies — we'd rather
      // count an unshipped line than silently drop it.
      const qty = toNum(ln.QtyRemainingToShip ?? ln.QtyOrdered ?? ln.Qty);
      if (qty <= 0) { zeroQty++; continue; }

      const date = toIsoDate(ln.DateToBeShipped) || headerDate;
      if (!date) { noDate++; continue; }

      const unitPrice = toNum(ln.UnitPrice);
      const totalPrice = toNum(ln.LineAmount) || unitPrice * qty;
      // Cancel date: line-level wins (Xoro lets line cancels diverge
      // from header on split-fulfillment orders); else header; else
      // omit. Consumers (Sales Comps SO view) fall back to `date` when
      // missing, so legacy uploads pre-CancelDate-trim still work.
      const cancelDate = toIsoDate(ln.CancelDate) || headerCancelDate;

      events.push({
        sku, date, qty, orderNumber, customerName, unitPrice, totalPrice, store,
        customerPo: customerPo || undefined,
        cancelDate: cancelDate || undefined,
      });
    }
  }

  return { events, skipped: { noSku, noDate, zeroQty } };
}
