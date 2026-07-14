// Tests for OUTBOUND retail X12 generators (856 ASN + 810 invoice) →
// build856 / build810, plus SSCC-18 validity. Pure — no DB/network.

import { describe, it, expect } from "vitest";
import { build856, build810 } from "../edi/retailBuilders.js";
import { validateSscc18 } from "../edi/sscc.js";
import { parseEnvelope, interchangeControl, groupControl, transactionControl, el, segmentsByTag } from "../edi/parser.js";

const NOW = new Date("2026-07-14T15:30:00Z");

const PARTNER = {
  our_isa_qualifier: "ZZ", our_isa_id: "RINGOFFIRE", our_gs_id: "ROF",
  partner_isa_qualifier: "12", partner_isa_id: "RETAILERDC", partner_gs_id: "RETAILER",
  usage_indicator: "T", enabled_docs: ["856", "810", "997"], doc_map: {},
};

const INVOICE = {
  invoice_number: "INV-1001", invoice_date: NOW, po_number: "PO-55", po_date: NOW, ship_date: NOW,
  bill_to: { name: "Big Box Retail", id: "1234", address: "1 Retail Way", city: "Bentonville", state: "AR", zip: "72716", country: "US" },
  ship_to: { name: "Big Box DC 07", id: "07", address: "700 DC Rd", city: "Fort Worth", state: "TX", zip: "76102" },
  remit_to: { name: "Ring of Fire Clothing" },
  lines: [
    { line: 1, sku: "SHIRT-RED-M", upc: "012345678905", qty: 12, unit: "EA", unit_price_cents: 875, line_total_cents: 10500, description: "Red shirt M" },
    { line: 2, sku: "SHIRT-RED-L", upc: "012345678912", qty: 8, unit: "EA", unit_price_cents: 1000, line_total_cents: 8000, description: "Red shirt L" },
  ],
  charges: [{ amount_cents: 500, code: "D240", description: "Freight" }],
  allowances: [{ amount_cents: 1000, code: "C310", description: "Trade discount" }],
};

const SHIPMENT = {
  shipment_id: "SHP-1001", ship_date: NOW, po_number: "PO-55", po_date: NOW, invoice_number: "INV-1001",
  carrier_scac: "FDEG", carrier_name: "FedEx Ground", bol_number: "BOL-999", tracking_number: "1Z9999", carton_count: 1, weight_lb: 42,
  ship_to: { name: "Big Box DC 07", id: "07", address: "700 DC Rd", city: "Fort Worth", state: "TX", zip: "76102" },
  ship_from: { name: "Ring of Fire Clothing" },
  gs1: { extension_digit: "0", prefix: "0361234" },
  lines: [
    { line: 1, sku: "SHIRT-RED-M", upc: "012345678905", qty: 12, unit: "EA", description: "Red shirt M" },
    { line: 2, sku: "SHIRT-RED-L", upc: "012345678912", qty: 8, unit: "EA", description: "Red shirt L" },
  ],
};

describe("build810 — invoice envelope + footing", () => {
  const built = build810({ invoice: INVOICE, partner: PARTNER, controlNumber: 424242, now: NOW });
  const env = parseEnvelope(built.x12);

  it("wraps ISA/GS*IN*/ST*810 with the partner's ISA identity + test usage", () => {
    expect(built.x12.startsWith("ISA*")).toBe(true);
    expect(built.x12).toContain("GS*IN*");
    expect(built.x12).toContain("ST*810*");
    const isa = interchangeControl(env.isa);
    expect(isa.sender).toBe("RINGOFFIRE");
    expect(isa.receiver).toBe("RETAILERDC");
    expect(isa.controlNumber).toBe("000424242");
    expect(el(env.isa, 5).trim()).toBe("ZZ");   // our ISA qualifier
    expect(el(env.isa, 7).trim()).toBe("12");   // their ISA qualifier
    expect(el(env.isa, 15).trim()).toBe("T");   // usage indicator (test)
    expect(groupControl(env.groups[0].gs).functionalId).toBe("IN");
    expect(transactionControl(env.groups[0].transactions[0].st).transactionSet).toBe("810");
  });

  it("emits one IT1 per line with UPC + vendor part", () => {
    const segs = env.groups[0].transactions[0].segments;
    const it1 = segmentsByTag(segs, "IT1");
    expect(it1.length).toBe(2);
    expect(it1[0]).toContain("UP");           // UPC qualifier
    expect(it1[0]).toContain("012345678905");
    expect(it1[0]).toContain("VN");           // vendor part qualifier
    expect(it1[0]).toContain("SHIRT-RED-M");
    expect(it1[0][4]).toBe("8.75");           // unit price explicit decimal
  });

  it("TDS = Σ line totals + charges − allowances (implied 2-decimal cents)", () => {
    const segs = env.groups[0].transactions[0].segments;
    const tds = segmentsByTag(segs, "TDS")[0];
    // 10500 + 8000 + 500 − 1000 = 18000
    expect(tds[1]).toBe("18000");
    expect(built.totals).toMatchObject({ tds_cents: 18000, line_total_cents: 18500, charges_cents: 500, allowances_cents: 1000, line_count: 2, total_qty: 20 });
    const ctt = segmentsByTag(segs, "CTT")[0];
    expect(ctt[1]).toBe("2");
  });

  it("golden sample", () => { expect(built.x12).toMatchSnapshot(); });
});

describe("build856 — ASN HL hierarchy + SSCC tare label", () => {
  const built = build856({ shipment: SHIPMENT, partner: PARTNER, controlNumber: 424243, now: NOW });
  const env = parseEnvelope(built.x12);

  it("wraps ISA/GS*SH*/ST*856 + BSN", () => {
    expect(built.x12).toContain("GS*SH*");
    expect(built.x12).toContain("ST*856*");
    const segs = env.groups[0].transactions[0].segments;
    expect(segmentsByTag(segs, "BSN")[0][1]).toBe("00"); // original
    expect(transactionControl(env.groups[0].transactions[0].st).transactionSet).toBe("856");
  });

  it("builds a Shipment→Order→Tare→Item hierarchy", () => {
    const segs = env.groups[0].transactions[0].segments;
    const hl = segmentsByTag(segs, "HL");
    // S(1) + O(1) + T(1) + I(2) = 5
    expect(hl.length).toBe(5);
    expect(hl.map((s) => s[3])).toEqual(["S", "O", "T", "I", "I"]);
    expect(built.hl_count).toBe(5);
    const ctt = segmentsByTag(segs, "CTT")[0];
    expect(ctt[1]).toBe("5");
  });

  it("MAN carries a valid SSCC-18 tare label; single_pack flagged", () => {
    const segs = env.groups[0].transactions[0].segments;
    const man = segmentsByTag(segs, "MAN")[0];
    expect(man[1]).toBe("GM");
    expect(man[2]).toHaveLength(18);
    expect(validateSscc18(man[2])).toBe(true);
    expect(built.ssccs).toHaveLength(1);
    expect(validateSscc18(built.ssccs[0])).toBe(true);
    expect(built.single_pack).toBe(true);
  });

  it("golden sample", () => { expect(built.x12).toMatchSnapshot(); });
});

describe("per-partner map overrides", () => {
  it("hierarchy override drops the tare level (no MAN, no SSCC)", () => {
    const partner = { ...PARTNER, doc_map: { "856": { hierarchy: ["S", "O", "I"] } } };
    const built = build856({ shipment: SHIPMENT, partner, controlNumber: 1, now: NOW });
    const segs = parseEnvelope(built.x12).groups[0].transactions[0].segments;
    expect(segmentsByTag(segs, "MAN").length).toBe(0);
    expect(built.ssccs).toHaveLength(0);
    expect(segmentsByTag(segs, "HL").length).toBe(4); // S + O + 2×I
  });

  it("810 line_id_qual can force GTIN-14 (UK) as the primary id", () => {
    const partner = { ...PARTNER, doc_map: { "810": { line_id_qual: "UK" } } };
    const inv = { ...INVOICE, lines: [{ ...INVOICE.lines[0], gtin: "00012345678905" }] };
    const built = build810({ invoice: inv, partner, controlNumber: 1, now: NOW });
    const it1 = segmentsByTag(parseEnvelope(built.x12).groups[0].transactions[0].segments, "IT1")[0];
    expect(it1).toContain("UK");
    expect(it1).toContain("00012345678905");
  });

  it("usage P emits a production interchange (ISA15=P)", () => {
    const partner = { ...PARTNER, usage_indicator: "P" };
    const built = build810({ invoice: INVOICE, partner, controlNumber: 1, now: NOW });
    expect(el(parseEnvelope(built.x12).isa, 15).trim()).toBe("P");
  });
});
