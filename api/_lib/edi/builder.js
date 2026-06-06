// api/_lib/edi/builder.js
//
// X12 envelope builder. Emits standard ASC X12 004010 messages.
// Used to produce:
//   997 Functional Acknowledgment (response to inbound transactions)
//   850 Purchase Order             (outbound when PO is issued)
//   820 Payment Order / Remittance (outbound when payment is sent)
//
// Delimiters: element=*, component=>, segment=~. These are the common
// defaults; adjust via env if a partner requires different ones.

const SEP = "*";
const COMP = ">";
const SEG = "~";

function pad(value, len, filler = " ", align = "left") {
  const s = String(value ?? "");
  if (s.length >= len) return s.slice(0, len);
  const p = filler.repeat(len - s.length);
  return align === "left" ? s + p : p + s;
}

function fmtDate(d) { // YYMMDD for ISA09, YYYYMMDD for GS04 etc.
  const dt = d instanceof Date ? d : new Date(d);
  const yyyy = String(dt.getUTCFullYear());
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return { yy: yyyy.slice(-2), yyyy, mm, dd };
}

function fmtTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const mm = String(dt.getUTCMinutes()).padStart(2, "0");
  return hh + mm;
}

function seg(...parts) { return parts.join(SEP); }

function isa({ sender, receiver, controlNumber, now = new Date(), usageIndicator = "P" }) {
  const d = fmtDate(now);
  const t = fmtTime(now);
  return [
    "ISA",
    "00", pad("", 10),           // auth qual + value
    "00", pad("", 10),           // security qual + value
    "ZZ", pad(sender,   15),     // sender qual + id
    "ZZ", pad(receiver, 15),     // receiver qual + id
    `${d.yy}${d.mm}${d.dd}`,
    t,
    "U",                         // repetition separator (U = legacy)
    "00401",
    pad(String(controlNumber), 9, "0", "right"),
    "0",                         // ack requested
    usageIndicator,              // P=prod, T=test
    COMP,
  ].join(SEP);
}

function gs({ functionalId, sender, receiver, controlNumber, now = new Date() }) {
  const d = fmtDate(now);
  return seg("GS", functionalId, sender, receiver, `${d.yyyy}${d.mm}${d.dd}`, fmtTime(now), String(controlNumber), "X", "004010");
}

function ge(count, controlNumber) { return seg("GE", String(count), String(controlNumber)); }
function iea(count, controlNumber) { return seg("IEA", String(count), pad(String(controlNumber), 9, "0", "right")); }
function se(segCount, controlNumber) { return seg("SE", String(segCount), String(controlNumber)); }

function wrapEnvelope(sender, receiver, controlNumber, functionalId, transactionContent) {
  const now = new Date();
  const parts = [
    isa({ sender, receiver, controlNumber, now }),
    gs({ functionalId, sender, receiver, controlNumber, now }),
    transactionContent,
    ge(1, controlNumber),
    iea(1, controlNumber),
  ];
  return parts.map((s) => s + SEG).join("");
}

export function build997({ sender, receiver, controlNumber, ackForGroup, ackForControl, accepted = true, transactionSet = "997" }) {
  const st = seg("ST", transactionSet, "0001");
  const ak1 = seg("AK1", ackForGroup.functionalId, ackForGroup.controlNumber);
  const ak9 = seg("AK9", accepted ? "A" : "R", "1", "1", accepted ? "1" : "0");
  const segments = [st, ak1, ak9].map((s) => s + SEG).join("");
  const segCount = 3 + 1; // ST + AK1 + AK9 + SE
  const txnContent = segments + se(segCount, "0001") + SEG;
  return wrapEnvelope(sender, receiver, controlNumber, "FA", txnContent);
}

// 850 Purchase Order — minimal fields for downstream mapping.
// po: { po_number, order_date, currency, buyer, line_items: [{line, sku, qty, unit, price, description}] }
export function build850({ sender, receiver, controlNumber, po }) {
  const d = fmtDate(po.order_date || new Date());
  const txnId = "0001";
  const segs = [];
  segs.push(seg("ST", "850", txnId));
  segs.push(seg("BEG", "00", "SA", po.po_number, "", `${d.yyyy}${d.mm}${d.dd}`));
  if (po.currency) segs.push(seg("CUR", "BY", po.currency));
  segs.push(seg("REF", "IA", po.buyer || "ROF"));
  let lineCount = 0;
  for (const li of po.line_items || []) {
    lineCount++;
    segs.push(seg("PO1", String(li.line || lineCount), String(li.qty || 0), li.unit || "EA", li.price != null ? String(li.price) : "", "", li.sku ? "VP" : "", li.sku || ""));
    if (li.description) segs.push(seg("PID", "F", "", "", "", li.description));
  }
  segs.push(seg("CTT", String(lineCount)));
  const segCount = segs.length + 1; // incl SE
  segs.push(se(segCount, txnId));
  const txnContent = segs.map((s) => s + SEG).join("");
  return wrapEnvelope(sender, receiver, controlNumber, "PO", txnContent);
}

// 940 Warehouse Shipping Order — instructs a 3PL/warehouse to ship goods.
// Sent OUTBOUND when a sales order is waved to the 3PL that holds our stock.
//
// order: {
//   shipment_number,             // our reference (W05 BSN-equivalent)
//   order_date,
//   po_number?,                  // customer PO if any
//   carrier?,                    // SCAC / carrier name (W66)
//   ship_to: { name, address?, city?, state?, zip?, country? },
//   ship_from: { name },         // the warehouse / 3PL
//   line_items: [{ line, sku, qty, unit, description }],
// }
export function build940({ sender, receiver, controlNumber, order }) {
  const d = fmtDate(order.order_date || new Date());
  const txnId = "0001";
  const segs = [];
  segs.push(seg("ST", "940", txnId));
  // W05 — Shipping Order Identification: order type 'N' (new), depositor order number.
  segs.push(seg("W05", "N", order.shipment_number || "", order.po_number || ""));
  // N1 loops — ship-to (ST) and warehouse/from (WH).
  const st = order.ship_to || {};
  segs.push(seg("N1", "ST", st.name || ""));
  if (st.address) segs.push(seg("N3", st.address));
  if (st.city || st.state || st.zip) segs.push(seg("N4", st.city || "", st.state || "", st.zip || "", st.country || "US"));
  const wh = order.ship_from || {};
  segs.push(seg("N1", "WH", wh.name || ""));
  // W66 — Warehouse Carrier Information (carrier detail), if a carrier is set.
  if (order.carrier) segs.push(seg("W66", "", "", "", "", order.carrier));
  // Line items: LX (line number) + W01 (line item detail: qty, unit, sku).
  let lineCount = 0;
  let totalQty = 0;
  for (const li of order.line_items || []) {
    lineCount++;
    totalQty += Number(li.qty) || 0;
    segs.push(seg("LX", String(li.line || lineCount)));
    segs.push(seg("W01", String(li.qty || 0), li.unit || "EA", "", "", "", "VN", li.sku || ""));
    if (li.description) segs.push(seg("G69", li.description));
  }
  // W76 — Total Shipping Order: total line items + total quantity.
  segs.push(seg("W76", String(lineCount), String(totalQty)));
  const segCount = segs.length + 1; // incl SE
  segs.push(se(segCount, txnId));
  const txnContent = segs.map((s) => s + SEG).join("");
  // 940 functional group identifier code is OW (Warehouse Shipping Order).
  return wrapEnvelope(sender, receiver, controlNumber, "OW", txnContent);
}

// 945 Warehouse Shipping Advice — INBOUND from the 3PL confirming what shipped.
// Returns a parsed summary (qty shipped per line + carrier/tracking) from raw
// X12 segments. Lightweight, structured parse — enough to advance the shipment.
//   segments: [["ST","945",..], ["W06",..], ["LX",..], ["W12",qty,..], ...]
export function parse945(segments) {
  const out = { shipment_number: null, carrier: null, tracking_number: null, lines: [] };
  let cur = null;
  for (const s of segments || []) {
    const tag = (s[0] || "").toUpperCase();
    if (tag === "W06") {
      // W06 — Warehouse Shipment Identification: depositor order number in elem 2.
      out.shipment_number = s[2] || s[1] || null;
    } else if (tag === "W27") {
      // W27 — Carrier Detail: routing in elem 2, carrier (SCAC) in elem 3.
      out.carrier = s[3] || s[2] || null;
    } else if (tag === "W12") {
      // W12 — Warehouse Item Detail: status, qty ordered, qty shipped, unit, ... sku.
      cur = {
        qty_shipped: Number(s[3] ?? s[2] ?? 0) || 0,
        unit: s[4] || "EA",
        sku: s[8] || s[7] || null,
      };
      out.lines.push(cur);
    } else if (tag === "REF" && (s[1] === "CN" || s[1] === "2I") && cur) {
      // Carrier tracking / pro number on a REF segment.
      out.tracking_number = s[2] || out.tracking_number;
    } else if (tag === "REF" && (s[1] === "CN" || s[1] === "2I")) {
      out.tracking_number = s[2] || out.tracking_number;
    }
  }
  return out;
}

// 820 Payment Order/Remittance — single-invoice payment envelope.
// payment: { amount, currency, effective_date, vendor_id, invoices: [{invoice_number, amount}] }
export function build820({ sender, receiver, controlNumber, payment }) {
  const d = fmtDate(payment.effective_date || new Date());
  const txnId = "0001";
  const segs = [];
  segs.push(seg("ST", "820", txnId));
  segs.push(seg("BPR", "C", String(payment.amount || 0), "C", "ACH", "", "", "", "", "", "", "", "", "", "", "", `${d.yyyy}${d.mm}${d.dd}`));
  segs.push(seg("TRN", "1", payment.payment_ref || `ROF-${Date.now()}`));
  if (payment.currency && payment.currency !== "USD") segs.push(seg("CUR", "PR", payment.currency));
  segs.push(seg("N1", "PR", payment.payer_name || "Ring of Fire"));
  segs.push(seg("N1", "PE", payment.payee_name || ""));
  for (const inv of payment.invoices || []) {
    segs.push(seg("RMR", "IV", inv.invoice_number, "", String(inv.amount || 0)));
  }
  const segCount = segs.length + 1;
  segs.push(se(segCount, txnId));
  const txnContent = segs.map((s) => s + SEG).join("");
  return wrapEnvelope(sender, receiver, controlNumber, "RA", txnContent);
}
