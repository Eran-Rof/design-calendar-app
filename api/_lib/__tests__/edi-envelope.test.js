// Tests for X12 envelope generation + round-trip parsing used by the 3PL
// transport flow (build940 / build997 → parseEnvelope). Pure — no DB/network.

import { describe, it, expect } from "vitest";
import { build940, build997 } from "../edi/builder.js";
import { parseEnvelope, interchangeControl, groupControl, transactionControl } from "../edi/parser.js";

const ORDER = {
  shipment_number: "TPL-2026-00042",
  order_date: new Date("2026-07-14T00:00:00Z"),
  po_number: "SO-1001",
  ship_to: { name: "Acme Retail", address: "1 Market St", city: "SF", state: "CA", zip: "94103", country: "US" },
  ship_from: { name: "West Coast 3PL" },
  line_items: [
    { line: 1, sku: "SHIRT-RED-M", qty: 12, unit: "EA", description: "Red shirt M" },
    { line: 2, sku: "SHIRT-RED-L", qty: 8, unit: "EA", description: "Red shirt L" },
  ],
};

describe("build940 — warehouse shipping order envelope", () => {
  const ctl = 424242;
  const raw = build940({ sender: "RINGOFFIRE", receiver: "WC3PL", controlNumber: ctl, order: ORDER });

  it("wraps a well-formed ISA/GS/ST … SE/GE/IEA envelope", () => {
    expect(raw.startsWith("ISA*")).toBe(true);
    expect(raw).toContain("GS*OW*");        // 940 functional group = OW
    expect(raw).toContain("ST*940*");
    expect(raw.trim().endsWith("IEA*1*000424242~")).toBe(true);
  });

  it("carries the control number in ISA13 / GS06 / IEA", () => {
    const env = parseEnvelope(raw);
    const isa = interchangeControl(env.isa);
    expect(isa.controlNumber).toBe("000424242");
    expect(isa.sender).toBe("RINGOFFIRE");
    expect(isa.receiver).toBe("WC3PL");
    const gs = groupControl(env.groups[0].gs);
    expect(gs.functionalId).toBe("OW");
    expect(gs.controlNumber).toBe(String(ctl));
  });

  it("emits one W01 line per item + a W76 total", () => {
    const env = parseEnvelope(raw);
    const segs = env.groups[0].transactions[0].segments;
    const w01 = segs.filter((s) => s[0] === "W01");
    expect(w01.length).toBe(2);
    const w76 = segs.find((s) => s[0] === "W76");
    expect(w76).toBeTruthy();
    expect(w76[1]).toBe("2");   // total lines
    expect(w76[2]).toBe("20");  // total qty 12+8
  });

  it("round-trips: ST transaction set parses back to 940", () => {
    const env = parseEnvelope(raw);
    const st = transactionControl(env.groups[0].transactions[0].st);
    expect(st.transactionSet).toBe("940");
  });
});

describe("build997 — functional acknowledgment", () => {
  it("acknowledges a group with AK1/AK9 and FA functional id", () => {
    const raw = build997({
      sender: "RINGOFFIRE", receiver: "WC3PL", controlNumber: 555,
      ackForGroup: { functionalId: "OW", controlNumber: "424242" }, accepted: true,
    });
    expect(raw).toContain("GS*FA*");
    expect(raw).toContain("ST*997*");
    expect(raw).toContain("AK1*OW*424242");
    expect(raw).toContain("AK9*A*");
  });
});
