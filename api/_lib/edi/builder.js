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

export function pad(value, len, filler = " ", align = "left") {
  const s = String(value ?? "");
  if (s.length >= len) return s.slice(0, len);
  const p = filler.repeat(len - s.length);
  return align === "left" ? s + p : p + s;
}

export function fmtDate(d) { // YYMMDD for ISA09, YYYYMMDD for GS04 etc.
  const dt = d instanceof Date ? d : new Date(d);
  const yyyy = String(dt.getUTCFullYear());
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return { yy: yyyy.slice(-2), yyyy, mm, dd };
}

export function fmtTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const mm = String(dt.getUTCMinutes()).padStart(2, "0");
  return hh + mm;
}

export function seg(...parts) { return parts.join(SEP); }

// ISA interchange header. senderQual/receiverQual default to "ZZ" (mutually
// defined) — the legacy behaviour used by build850/820/940/997 via wrapEnvelope;
// retail partners override them (01=DUNS, 12=phone, 08=UCC/EAN, etc.).
function isa({ sender, receiver, controlNumber, now = new Date(), usageIndicator = "P", senderQual = "ZZ", receiverQual = "ZZ" }) {
  const d = fmtDate(now);
  const t = fmtTime(now);
  return [
    "ISA",
    "00", pad("", 10),           // auth qual + value
    "00", pad("", 10),           // security qual + value
    pad(senderQual, 2), pad(sender,   15),   // sender qual + id
    pad(receiverQual, 2), pad(receiver, 15), // receiver qual + id
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
export function se(segCount, controlNumber) { return seg("SE", String(segCount), String(controlNumber)); }

function wrapEnvelope(sender, receiver, controlNumber, functionalId, transactionContent) {
  return x12Envelope({ sender, receiver, controlNumber, functionalId, transactionContent });
}

// General ISA/GS…GE/IEA envelope with per-partner ISA qualifiers, usage
// indicator (P/T), and optional distinct GS control number. transactionContent
// already ends with its SE~. Emits every segment terminated by SEG.
export function x12Envelope({
  sender, receiver, controlNumber, functionalId, transactionContent,
  senderQual = "ZZ", receiverQual = "ZZ", gsSender, gsReceiver,
  groupControlNumber, usageIndicator = "P", now = new Date(),
}) {
  const gsCtl = groupControlNumber != null ? groupControlNumber : controlNumber;
  const parts = [
    isa({ sender, receiver, controlNumber, now, usageIndicator, senderQual, receiverQual }),
    gs({ functionalId, sender: gsSender || sender, receiver: gsReceiver || receiver, controlNumber: gsCtl, now }),
    transactionContent,
    ge(1, gsCtl),
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

// 846 Inventory Inquiry/Advice — INBOUND from the 3PL reporting on-hand per item.
// Returns { lines: [{ sku, qty_on_hand }] }. Walk in order: LIN starts an item,
// the following QTY (qualifier "33"/"ON"/"QA" = on-hand/available) sets its qty.
// SKU is taken from the LIN's product-id pair whose qualifier is a SKU/UPC type
// (SK/UP/UK/EN/VN); otherwise the first id value. 3PL 846 layouts vary — this is
// deliberately lenient and the handler also accepts CSV/JSON.
export function parse846(segments) {
  const out = { lines: [] };
  let cur = null;
  const SKU_QUALS = new Set(["SK", "UP", "UK", "EN", "VN", "IN", "BP"]);
  for (const s of segments || []) {
    const tag = (s[0] || "").toUpperCase();
    if (tag === "LIN") {
      // LIN — Item Identification: LIN*<assigned>*<qual1>*<id1>*<qual2>*<id2>...
      // Scan qualifier/id pairs from element 2 onward; prefer a SKU/UPC-type id.
      let sku = null, firstId = null;
      for (let i = 2; i + 1 < s.length; i += 2) {
        const qual = (s[i] || "").toUpperCase();
        const id = s[i + 1] || null;
        if (id && firstId == null) firstId = id;
        if (id && SKU_QUALS.has(qual)) { sku = id; break; }
      }
      cur = { sku: sku || firstId || null, qty_on_hand: 0 };
      out.lines.push(cur);
    } else if (tag === "QTY" && cur) {
      // QTY*<qualifier>*<quantity>. 33 = quantity on hand, QA/AV = available.
      const qual = (s[1] || "").toUpperCase();
      const qty = Number(s[2] || 0) || 0;
      if (qual === "33" || qual === "ON" || qual === "QA" || qual === "AV" || qual === "17" || cur.qty_on_hand === 0) {
        cur.qty_on_hand = qty;
      }
    }
  }
  return out;
}

// 944 Stock Transfer Receipt Advice — INBOUND from the 3PL confirming what it
// actually RECEIVED into the warehouse against a PO. Returns
// { po_number, receipt_date, lines: [{ sku, qty_received }] }. Layouts vary a
// lot between 3PLs, so this is deliberately lenient (mirrors parse846); the
// handler also accepts a structured JSON/CSV payload, which is the reliable path.
//   • PO number: REF*PO*<po> / N9*PO*<po> / a W17 depositor-order element.
//   • receipt date: W17 date element (CCYYMMDD) or G62*<qual>*<date>.
//   • lines: W07*<qty received>*<unit>*<UPC>*<qual>*<id>… (sku = a SKU/UPC-type
//     product id, else the UPC, else the first id).
export function parse944(segments) {
  const out = { po_number: null, receipt_date: null, lines: [] };
  const SKU_QUALS = new Set(["SK", "UP", "UK", "EN", "VN", "IN", "BP", "UA"]);
  const isDate8 = (v) => /^\d{8}$/.test(String(v || ""));
  const toIso = (v) => `${String(v).slice(0, 4)}-${String(v).slice(4, 6)}-${String(v).slice(6, 8)}`;
  for (const s of segments || []) {
    const tag = (s[0] || "").toUpperCase();
    if ((tag === "REF" || tag === "N9") && (s[1] || "").toUpperCase() === "PO") {
      out.po_number = out.po_number || s[2] || null;
    } else if (tag === "W17") {
      // Date only — the PO number is taken from REF*PO / N9*PO (a W17 element is
      // ambiguous: the receipt number also lives here).
      for (let i = 1; i < s.length; i++) if (!out.receipt_date && isDate8(s[i])) { out.receipt_date = toIso(s[i]); break; }
    } else if (tag === "G62" && !out.receipt_date && isDate8(s[2])) {
      out.receipt_date = toIso(s[2]);
    } else if (tag === "W07") {
      const qty = Number(s[1] ?? 0) || 0;
      let sku = null, firstId = null;
      const upc = s[3] || null;
      for (let i = 4; i + 1 < s.length; i += 2) {
        const qual = (s[i] || "").toUpperCase();
        const id = s[i + 1] || null;
        if (id && firstId == null) firstId = id;
        if (id && SKU_QUALS.has(qual)) { sku = id; break; }
      }
      out.lines.push({ sku: sku || firstId || upc || null, qty_received: qty });
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
