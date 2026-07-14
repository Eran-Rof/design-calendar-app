// api/_lib/edi/retailBuilders.js
//
// OUTBOUND retail-customer X12 generators (Ring of Fire → big-box retailer):
//   build856(shipment, partner) — 856 Advance Ship Notice (ASN).
//                                 HL hierarchy Shipment→Order→Tare→Item with an
//                                 SSCC-18 carton (tare) label per MAN segment.
//   build810(invoice,  partner) — 810 Invoice. BIG header, N1 loops, IT1 lines
//                                 (per SKU: qty, unit price, UPC/GTIN/vendor
//                                 part), SAC allowances/charges, TDS/CTT totals.
//
// ⚠️ These are GENERATORS. The 856/810 handlers in builder.js are INBOUND
//    PARSERS (vendor→us via mappers.js). Do not conflate the two directions.
//
// Both are per-partner MAP driven (edi_customer_partners.doc_map JSONB): segment
// and qualifier variations differ retailer-to-retailer, so nothing retail-
// specific is hardcoded — the map overrides defaults. Envelopes (ISA/GS/ST)
// reuse builder.js's x12Envelope with the partner's ISA qualifiers/IDs + usage
// indicator. Control numbers come from the caller (nextControlNumber in outbox).
//
// Pure + side-effect-free → unit-testable without a DB or SFTP (see
// api/_lib/__tests__/edi-retail-builders.test.js).

import { seg, se, fmtDate, fmtTime, x12Envelope } from "./builder.js";
import { buildSscc18, serialFromId } from "./sscc.js";

const SEG = "~";

// ─── Functional group ids (GS01) for outbound retail docs ─────────────────────
export const RETAIL_FUNCTIONAL_ID = { "856": "SH", "810": "IN", "997": "FA" };

// ─── Envelope + map resolution from the partner config ────────────────────────
function resolveEnvelope(partner) {
  const p = partner || {};
  const usage = String(p.usage_indicator || "T").toUpperCase().startsWith("P") ? "P" : "T";
  return {
    senderQual:  p.our_isa_qualifier || "ZZ",
    sender:      p.our_isa_id || "RINGOFFIRE",
    receiverQual: p.partner_isa_qualifier || "ZZ",
    receiver:    p.partner_isa_id || "PARTNER",
    gsSender:    p.our_gs_id || p.our_isa_id || "RINGOFFIRE",
    gsReceiver:  p.partner_gs_id || p.partner_isa_id || "PARTNER",
    usageIndicator: usage,
  };
}

function docMap(partner, doc) {
  const m = partner && partner.doc_map;
  if (!m || typeof m !== "object") return {};
  return (m[doc] && typeof m[doc] === "object") ? m[doc] : {};
}

// ─── Money helpers ────────────────────────────────────────────────────────────
// Explicit-decimal dollars for IT1 unit price (X12 type R), e.g. 1050 → "10.50".
function centsToAmount(cents) {
  const n = Math.round(Number(cents) || 0);
  const neg = n < 0;
  const a = Math.abs(n);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
// Implied-2-decimal integer for TDS / SAC amounts (X12 type N2): 10500 → "10500".
function n2(cents) { return String(Math.round(Number(cents) || 0)); }

function ymd(d) { const f = fmtDate(d); return `${f.yyyy}${f.mm}${f.dd}`; }

// Product-id qualifier/value pairs shared by IT1 (810) and LIN (856).
//   UP = UPC-A (GTIN-12), UK = GTIN-14, VN = vendor/supplier part number (SKU).
// map.line_id_qual can force the primary marketplace id; the SKU always trails
// as VN so the retailer can cross-reference our catalog.
function idQualPairs(li, map) {
  const pairs = [];
  const upc = li.upc || null, gtin = li.gtin || null, sku = li.sku || null;
  const forced = map.line_id_qual;
  if (forced === "UK" && gtin) pairs.push("UK", gtin);
  else if (forced === "UP" && upc) pairs.push("UP", upc);
  else if (upc) pairs.push("UP", upc);
  else if (gtin) pairs.push("UK", gtin);
  if (sku) pairs.push("VN", sku);
  if (pairs.length === 0) pairs.push("VN", sku || "");
  return pairs;
}

// N1 party loop (+ N3/N4 address). Skipped entirely when the party is absent.
function pushN1(segs, code, party, qual, id) {
  if (!party) return;
  const p = party;
  const entityId = id || p.id || null;
  const q = qual || p.id_qual || (entityId ? "92" : null); // 92 = assigned by buyer
  if (entityId && q) segs.push(seg("N1", code, p.name || "", q, entityId));
  else segs.push(seg("N1", code, p.name || ""));
  if (p.address) segs.push(seg("N3", p.address));
  if (p.city || p.state || p.zip) segs.push(seg("N4", p.city || "", p.state || "", p.zip || "", p.country || "US"));
}

function finish(segs, txnId, env, { controlNumber, groupControlNumber, functionalId, now }) {
  const segCount = segs.length + 1; // + SE itself
  segs.push(se(segCount, txnId));
  const transactionContent = segs.map((s) => s + SEG).join("");
  return x12Envelope({ ...env, controlNumber, groupControlNumber, functionalId, transactionContent, now });
}

// ══════════════════════════════════════════════════════════════════════════════
// 810 INVOICE
// ══════════════════════════════════════════════════════════════════════════════
// invoice: {
//   invoice_number, invoice_date, po_number, po_date, currency, ship_date,
//   bill_to, ship_to, remit_to  (each { name, id?, id_qual?, address, city, state, zip, country }),
//   terms: { type_code?, discount_pct?, discount_days?, net_days? },
//   lines: [{ line, sku, upc, gtin, qty, unit, unit_price_cents, line_total_cents, description }],
//   allowances: [{ amount_cents, code?, description? }],  // reduce TDS
//   charges:    [{ amount_cents, code?, description? }],   // add to TDS
// }
export function build810({ invoice, partner, controlNumber, groupControlNumber, now = new Date() }) {
  const env = resolveEnvelope(partner);
  const map = docMap(partner, "810");
  const inv = invoice || {};
  const txnId = "0001";
  const segs = [];

  segs.push(seg("ST", "810", txnId));
  // BIG: invoice date, invoice #, PO date, PO #, ..., transaction type (DR = debit/invoice).
  segs.push(seg("BIG", ymd(inv.invoice_date || now), inv.invoice_number || "",
    inv.po_date ? ymd(inv.po_date) : "", inv.po_number || "", "", "", map.big_transaction_type || "DR"));
  if (inv.currency && inv.currency !== "USD") segs.push(seg("CUR", "SE", inv.currency));
  if (map.vendor_number) segs.push(seg("REF", "IA", map.vendor_number)); // our vendor # at the retailer

  pushN1(segs, "BY", inv.bill_to, map.buyer_qual, map.buyer_id); // buyer
  pushN1(segs, "ST", inv.ship_to);                               // ship-to
  pushN1(segs, "RE", inv.remit_to);                              // remit-to (us)

  if (inv.terms) {
    const t = inv.terms;
    segs.push(seg("ITD", t.type_code || "01", "3",
      t.discount_pct != null ? String(t.discount_pct) : "", "",
      t.discount_days != null ? String(t.discount_days) : "", "",
      t.net_days != null ? String(t.net_days) : ""));
  }
  if (inv.ship_date) segs.push(seg("DTM", "011", ymd(inv.ship_date)));

  let lineCount = 0, totalQty = 0, lineSumCents = 0;
  for (const li of inv.lines || []) {
    lineCount++;
    const qty = Number(li.qty) || 0;
    totalQty += qty;
    const lt = li.line_total_cents != null ? Number(li.line_total_cents) : Math.round((Number(li.unit_price_cents) || 0) * qty);
    lineSumCents += lt;
    const idPairs = idQualPairs(li, map);
    // IT1: assigned line, qty invoiced, unit, unit price, price basis, then id pairs.
    segs.push(seg("IT1", String(li.line || lineCount), String(qty), li.unit || "EA",
      centsToAmount(li.unit_price_cents), "", ...idPairs));
    if (map.include_pid !== false && li.description) segs.push(seg("PID", "F", "", "", "", li.description));
  }

  // Summary allowances (SAC*A) / charges (SAC*C).
  let allowCents = 0, chargeCents = 0;
  for (const a of inv.allowances || []) {
    const amt = Math.abs(Number(a.amount_cents) || 0); allowCents += amt;
    segs.push(seg("SAC", "A", a.code || "C310", "", "", n2(amt), "", "", "", "", "", "", "", a.description || ""));
  }
  for (const c of inv.charges || []) {
    const amt = Math.abs(Number(c.amount_cents) || 0); chargeCents += amt;
    segs.push(seg("SAC", "C", c.code || "D240", "", "", n2(amt), "", "", "", "", "", "", "", c.description || ""));
  }

  const tdsCents = lineSumCents + chargeCents - allowCents;
  segs.push(seg("TDS", n2(tdsCents)));                 // total invoice amount (N2)
  segs.push(seg("CTT", String(lineCount), String(totalQty)));

  const x12 = finish(segs, txnId, env, { controlNumber, groupControlNumber, functionalId: "IN", now });
  return {
    x12, transaction_set: "810", functionalId: "IN",
    controlNumber, groupControlNumber: groupControlNumber ?? controlNumber,
    totals: { tds_cents: tdsCents, line_total_cents: lineSumCents, charges_cents: chargeCents, allowances_cents: allowCents, line_count: lineCount, total_qty: totalQty },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 856 ADVANCE SHIP NOTICE (ASN)
// ══════════════════════════════════════════════════════════════════════════════
// shipment: {
//   shipment_id, ship_date, po_number, po_date, invoice_number,
//   carrier_scac, carrier_name, bol_number, tracking_number, carton_count, weight_lb,
//   ship_to, ship_from  (each { name, id?, id_qual?, address, city, state, zip, country }),
//   gs1: { extension_digit, prefix },   // SSCC-18 company prefix for tare labels
//   lines: [{ line, sku, upc, gtin, qty, unit, description }],
// }
// map.hierarchy overrides the HL structure (default ["S","O","T","I"]): use
// ["S","O","P","I"] for pack-not-tare retailers, ["S","O","I"] to drop the pack
// level. When no WMS carton/pack-out data exists the shipment collapses to a
// SINGLE tare (one SSCC over all items) and single_pack=true is flagged.
export function build856({ shipment, partner, controlNumber, groupControlNumber, now = new Date() }) {
  const env = resolveEnvelope(partner);
  const map = docMap(partner, "856");
  const sh = shipment || {};
  const txnId = "0001";
  const segs = [];

  const hierarchy = Array.isArray(map.hierarchy) && map.hierarchy.length ? map.hierarchy.map(String) : ["S", "O", "T", "I"];
  const packLevel = hierarchy.includes("T") ? "T" : (hierarchy.includes("P") ? "P" : null);
  const shipMoment = sh.ship_date || now;

  segs.push(seg("ST", "856", txnId));
  // BSN: purpose (00 original), shipment id, date, time, hierarchical structure code.
  segs.push(seg("BSN", "00", sh.shipment_id || "", ymd(shipMoment), fmtTime(shipMoment), map.structure_code || "0001"));

  let hlCount = 0;
  const ssccs = [];
  const addHL = (level, parentId) => { hlCount++; segs.push(seg("HL", String(hlCount), parentId != null ? String(parentId) : "", level)); return hlCount; };

  // ── Shipment level ──
  const shipHL = addHL("S", "");
  if (map.include_td1 !== false) {
    const cartons = sh.carton_count || 1;
    if (sh.weight_lb != null) segs.push(seg("TD1", "CTN25", String(cartons), "", "", "", "G", String(sh.weight_lb), "LB"));
    else segs.push(seg("TD1", "CTN25", String(cartons)));
  }
  if (map.include_td5 !== false && (sh.carrier_scac || sh.carrier_name)) {
    segs.push(seg("TD5", "", "2", sh.carrier_scac || "", "M", sh.carrier_name || ""));
  }
  if (sh.bol_number) segs.push(seg("REF", "BM", sh.bol_number));       // bill of lading
  if (sh.tracking_number) segs.push(seg("REF", "CN", sh.tracking_number)); // carrier pro / tracking
  segs.push(seg("DTM", "011", ymd(shipMoment)));                       // shipped date
  pushN1(segs, "ST", sh.ship_to, map.shipto_qual, map.shipto_id);
  pushN1(segs, "SF", sh.ship_from);

  // ── Order level ──
  let itemParent = shipHL;
  if (hierarchy.includes("O")) {
    const orderHL = addHL("O", shipHL);
    itemParent = orderHL;
    segs.push(seg("PRF", sh.po_number || "", "", "", sh.po_date ? ymd(sh.po_date) : "")); // PO reference
    if (sh.invoice_number) segs.push(seg("REF", "IV", sh.invoice_number));
  }

  // ── Tare / Pack level (single-pack fallback: one SSCC over all items) ──
  if (packLevel) {
    const serial = serialFromId(sh.shipment_id || sh.invoice_number || String(controlNumber));
    const sscc = buildSscc18(
      (sh.gs1 && sh.gs1.extension_digit) ?? map.sscc_extension_digit ?? "0",
      (sh.gs1 && sh.gs1.prefix) ?? map.gs1_prefix ?? "0000000",
      serial,
    );
    ssccs.push(sscc);
    const tareHL = addHL(packLevel, itemParent);
    itemParent = tareHL;
    segs.push(seg("MAN", map.man_qual || "GM", sscc)); // GM = SSCC-18 marks & numbers
  }

  // ── Item level — one HL per line ──
  let totalQty = 0;
  for (const li of sh.lines || []) {
    totalQty += Number(li.qty) || 0;
    addHL("I", itemParent);
    segs.push(seg("LIN", "", ...idQualPairs(li, map)));
    segs.push(seg("SN1", "", String(li.qty || 0), li.unit || "EA"));
    if (map.include_pid !== false && li.description) segs.push(seg("PID", "F", "", "", "", li.description));
  }

  segs.push(seg("CTT", String(hlCount))); // total HL segments

  const x12 = finish(segs, txnId, env, { controlNumber, groupControlNumber, functionalId: "SH", now });
  return {
    x12, transaction_set: "856", functionalId: "SH",
    controlNumber, groupControlNumber: groupControlNumber ?? controlNumber,
    ssccs, hl_count: hlCount, total_qty: totalQty,
    single_pack: !!packLevel && (sh.carton_count == null || Number(sh.carton_count) <= 1),
  };
}
