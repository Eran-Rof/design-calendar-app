// Unit tests for the outsourced-conversion (subcontracting) CMT posting rules.
// Pure functions — no DB. Verifies the accrue-at-receipt entry (DR WIP / CR 2160)
// and the 3-way-match vendor bill (DR 2160 / ±6320 PO Variance / CR AP), both on
// both bases, with correct subledgers and price-variance direction.

import { describe, it, expect } from "vitest";
import { mfgCmtAccrued } from "../mfgCmtAccrued.js";
import { mfgCmtInvoiceMatch } from "../mfgCmtInvoiceMatch.js";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const BUILD = "22222222-2222-2222-2222-222222222222";
const WIP = "33333333-3333-3333-3333-333333333333";
const ACCRUED_CMT = "77777777-7777-7777-7777-777777777777"; // 2160
const PPV = "88888888-8888-8888-8888-888888888888";        // 6320
const AP = "66666666-6666-6666-6666-666666666666";
const VENDOR = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const INVOICE = "99999999-9999-9999-9999-999999999999";

const sum = (lines, k) => lines.reduce((s, l) => s + Number(l[k]), 0);

describe("mfgCmtAccrued", () => {
  const event = { entity_id: ENTITY, data: {
    build_order_id: BUILD, posting_date: "2026-07-03", wip_account_id: WIP,
    accrued_cmt_account_id: ACCRUED_CMT, cmt_cents: 45000, build_number: "BUILD-00007",
  } };

  it("posts a balanced DR WIP / CR 2160 on both bases", () => {
    const out = mfgCmtAccrued(event);
    for (const je of [out.accrual, out.cash]) {
      expect(sum(je.lines, "debit")).toBeCloseTo(450);
      expect(sum(je.lines, "credit")).toBeCloseTo(450);
      expect(je.lines[0].account_id).toBe(WIP);
      expect(je.lines[0].subledger_type).toBe("build_order");
      expect(je.lines[0].subledger_id).toBe(BUILD);
      expect(je.lines[1].account_id).toBe(ACCRUED_CMT);
      // 2160 is a clearing account — no subledger (mirrors 2050 GR/IR).
      expect(je.lines[1].subledger_type).toBeNull();
    }
  });

  it("keys idempotency on the build id via mfg_cmt_accrual", () => {
    const out = mfgCmtAccrued(event);
    expect(out.accrual.source_table).toBe("mfg_cmt_accrual");
    expect(out.accrual.source_id).toBe(BUILD);
  });

  it("rejects a non-positive CMT", () => {
    expect(() => mfgCmtAccrued({ entity_id: ENTITY, data: { ...event.data, cmt_cents: 0 } })).toThrow();
  });
});

describe("mfgCmtInvoiceMatch", () => {
  const base = {
    invoice_id: INVOICE, vendor_id: VENDOR, invoice_number: "CMT-00007", invoice_date: "2026-07-10",
    ap_account_id: AP, accrued_cmt_account_id: ACCRUED_CMT, variance_account_id: PPV,
    build_number: "BUILD-00007",
  };

  it("clears the full accrual with no variance when the bill equals the accrued value", () => {
    const out = mfgCmtInvoiceMatch({ entity_id: ENTITY, data: { ...base, received_amount: "450.00", total_amount: "450.00" } });
    const lines = out.accrual.lines;
    expect(lines).toHaveLength(2); // DR 2160 + CR AP, no variance line
    expect(lines[0].account_id).toBe(ACCRUED_CMT);
    expect(Number(lines[0].debit)).toBeCloseTo(450);
    expect(lines[1].account_id).toBe(AP);
    expect(lines[1].subledger_type).toBe("vendor");
    expect(Number(lines[1].credit)).toBeCloseTo(450);
    expect(sum(lines, "debit")).toBeCloseTo(sum(lines, "credit"));
  });

  it("books a DR PO Variance when the bill exceeds the accrued value", () => {
    const out = mfgCmtInvoiceMatch({ entity_id: ENTITY, data: { ...base, received_amount: "450.00", total_amount: "500.00" } });
    const lines = out.accrual.lines;
    const ppv = lines.find((l) => l.account_id === PPV);
    expect(Number(ppv.debit)).toBeCloseTo(50);   // 500 − 450 over-bill → expense
    expect(Number(ppv.credit)).toBeCloseTo(0);
    expect(Number(lines.find((l) => l.account_id === AP).credit)).toBeCloseTo(500);
    expect(sum(lines, "debit")).toBeCloseTo(sum(lines, "credit"));
  });

  it("books a CR PO Variance when the bill is under the accrued value", () => {
    const out = mfgCmtInvoiceMatch({ entity_id: ENTITY, data: { ...base, received_amount: "450.00", total_amount: "420.00" } });
    const lines = out.accrual.lines;
    const ppv = lines.find((l) => l.account_id === PPV);
    expect(Number(ppv.credit)).toBeCloseTo(30);  // 420 − 450 under-bill → cost reduction
    expect(Number(ppv.debit)).toBeCloseTo(0);
    expect(sum(lines, "debit")).toBeCloseTo(sum(lines, "credit"));
  });

  it("posts identical entries on both bases and keys idempotency on the invoice", () => {
    const out = mfgCmtInvoiceMatch({ entity_id: ENTITY, data: { ...base, received_amount: "450.00", total_amount: "500.00" } });
    expect(out.cash).not.toBeNull();
    expect(sum(out.cash.lines, "debit")).toBeCloseTo(sum(out.accrual.lines, "debit"));
    expect(out.accrual.source_table).toBe("mfg_cmt_invoice");
    expect(out.accrual.source_id).toBe(INVOICE);
  });

  it("requires a variance account when the bill differs from the accrued value", () => {
    expect(() => mfgCmtInvoiceMatch({ entity_id: ENTITY, data: { ...base, variance_account_id: null, received_amount: "450.00", total_amount: "500.00" } })).toThrow();
  });
});
