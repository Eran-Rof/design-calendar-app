import { describe, it, expect } from "vitest";
import {
  AR_CONTROL_CODES,
  AP_CONTROL_CODE,
  CONTROL_CODES,
  TOLERANCE_CENTS,
  dollarsToCents,
  intCents,
  glNetCents,
  sumArOpenByAccountId,
  sumApOpenPosted,
  formatUsd,
  buildTieoutRows,
  runControlTieouts,
} from "../tieouts.js";

describe("dollarsToCents", () => {
  it("converts numbers and numeric strings precisely", () => {
    expect(dollarsToCents(1234.56)).toBe(123456);
    expect(dollarsToCents("1234.56")).toBe(123456);
    expect(dollarsToCents("-1234.5")).toBe(-123450);
    expect(dollarsToCents("0.01")).toBe(1);
    expect(dollarsToCents("1000000")).toBe(100000000);
    expect(dollarsToCents("$1,234.56")).toBe(123456);
  });
  it("survives the classic float trap", () => {
    // 0.1 + 0.2 style drift must not round the cent wrong.
    expect(dollarsToCents("4067004.07")).toBe(406700407);
    expect(dollarsToCents(4067004.07)).toBe(406700407);
  });
  it("returns 0 for junk", () => {
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents(undefined)).toBe(0);
    expect(dollarsToCents("")).toBe(0);
    expect(dollarsToCents("n/a")).toBe(0);
    expect(dollarsToCents(NaN)).toBe(0);
  });
});

describe("intCents", () => {
  it("coerces bigint-cents columns", () => {
    expect(intCents(150)).toBe(150);
    expect(intCents("150")).toBe(150);
    expect(intCents(null)).toBe(0);
    expect(intCents("x")).toBe(0);
  });
});

describe("glNetCents", () => {
  // v_trial_balance now returns TRUE integer cents (ROUND(SUM(..)*100)).
  const row = { debit_cents: 50000, credit_cents: 12025 };
  it("nets debit side for AR-style accounts", () => {
    expect(glNetCents(row, "debit")).toBe(37975);
  });
  it("nets credit side for AP-style accounts", () => {
    expect(glNetCents(row, "credit")).toBe(-37975);
  });
  it("missing row (no postings) → 0", () => {
    expect(glNetCents(undefined, "debit")).toBe(0);
    expect(glNetCents(null, "credit")).toBe(0);
  });
});

describe("sumArOpenByAccountId", () => {
  it("groups open balance by ar_account_id and tracks unmapped", () => {
    const { byAccountId, unmapped_cents } = sumArOpenByAccountId([
      { ar_account_id: "a1", total_amount_cents: 10_000, paid_amount_cents: 0 },
      { ar_account_id: "a1", total_amount_cents: 5_000, paid_amount_cents: 2_000 },
      { ar_account_id: "a2", total_amount_cents: 700, paid_amount_cents: 700 }, // fully paid → 0
      { ar_account_id: "a2", total_amount_cents: -300, paid_amount_cents: 0 }, // credit memo
      { ar_account_id: null, total_amount_cents: 999, paid_amount_cents: 0 },
    ]);
    expect(byAccountId.get("a1")).toBe(13_000);
    expect(byAccountId.get("a2")).toBe(-300);
    expect(unmapped_cents).toBe(999);
  });
  it("handles empty input", () => {
    const { byAccountId, unmapped_cents } = sumArOpenByAccountId([]);
    expect(byAccountId.size).toBe(0);
    expect(unmapped_cents).toBe(0);
  });
});

describe("sumApOpenPosted", () => {
  it("sums unpaid balance and total paid across posted bills", () => {
    const ap = sumApOpenPosted([
      { total_amount_cents: 10_000, paid_amount_cents: 0 },
      { total_amount_cents: 6_000, paid_amount_cents: 6_000 },
      { total_amount_cents: -500, paid_amount_cents: 0 }, // credit memo
    ]);
    expect(ap.open_cents).toBe(9_500);
    expect(ap.paid_total_cents).toBe(6_000);
    expect(ap.bills).toBe(3);
  });
});

describe("formatUsd", () => {
  it("formats cents including negatives", () => {
    expect(formatUsd(123456789)).toBe("$1,234,567.89");
    expect(formatUsd(-2)).toBe("-$0.02");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

function baseInputs() {
  const accountIdByCode = new Map([
    ["1105", "id-1105"],
    ["1107", "id-1107"],
    ["1108", "id-1108"],
    ["2000", "id-2000"],
  ]);
  // GL (TRUE integer cents): 1105 $100 DR-net, 1107 $250 DR-net, 1108 $0 (no
  // row), 2000 $80 CR-net.
  const tbRowByCode = new Map([
    ["1105", { debit_cents: 15000, credit_cents: 5000 }],
    ["1107", { debit_cents: 25000, credit_cents: 0 }],
    ["2000", { debit_cents: 2000, credit_cents: 10000 }],
  ]);
  const arByAccountId = new Map([
    ["id-1105", 10_000], // ties
    ["id-1107", 25_000], // ties
    ["id-1108", 0],
  ]);
  const ap = { open_cents: 8_000, paid_total_cents: 500, bills: 3 };
  return { accountIdByCode, tbRowByCode, arByAccountId, ap };
}

describe("buildTieoutRows", () => {
  it("returns one row per control account, all ok when everything ties", () => {
    const rows = buildTieoutRows(baseInputs());
    expect(rows.map((r) => r.account_code)).toEqual(CONTROL_CODES);
    for (const r of rows) {
      expect(r.status).toBe("ok");
      expect(r.diff_cents).toBe(0);
      expect(r.waived).toBeNull();
    }
    expect(rows.find((r) => r.account_code === AP_CONTROL_CODE).side).toBe("credit");
    for (const code of AR_CONTROL_CODES) {
      expect(rows.find((r) => r.account_code === code).side).toBe("debit");
    }
  });

  it("tolerates |diff| of exactly one cent but breaks beyond it", () => {
    const inputs = baseInputs();
    inputs.arByAccountId.set("id-1105", 10_001); // GL 10_000 vs sub 10_001 → -1¢
    inputs.arByAccountId.set("id-1107", 25_002); // -2¢ → break
    const rows = buildTieoutRows(inputs);
    const r1105 = rows.find((r) => r.account_code === "1105");
    const r1107 = rows.find((r) => r.account_code === "1107");
    expect(Math.abs(r1105.diff_cents)).toBe(TOLERANCE_CENTS);
    expect(r1105.status).toBe("ok");
    expect(r1107.diff_cents).toBe(-2);
    expect(r1107.status).toBe("break");
  });

  it("flags an AR account with GL activity but zero subledger", () => {
    const inputs = baseInputs();
    inputs.arByAccountId.delete("id-1107");
    const rows = buildTieoutRows(inputs);
    const r = rows.find((x) => x.account_code === "1107");
    expect(r.gl_cents).toBe(25_000);
    expect(r.subledger_cents).toBe(0);
    expect(r.status).toBe("break");
  });

  it("AP breaks normally once payments exist in the bills ledger", () => {
    const inputs = baseInputs();
    inputs.ap = { open_cents: 5_000, paid_total_cents: 500, bills: 3 };
    const rows = buildTieoutRows(inputs);
    const r = rows.find((x) => x.account_code === "2000");
    expect(r.diff_cents).toBe(3_000);
    expect(r.status).toBe("break");
    expect(r.waived).toBeNull();
  });

  it("AP is waived as pending_payments while sum(paid)=0 across posted bills", () => {
    const inputs = baseInputs();
    inputs.ap = { open_cents: 5_000, paid_total_cents: 0, bills: 3 };
    const rows = buildTieoutRows(inputs);
    const r = rows.find((x) => x.account_code === "2000");
    expect(r.diff_cents).toBe(3_000);
    expect(r.status).toBe("pending_payments");
    expect(r.waived).toBe("pending_payments");
  });

  it("AP that ties exactly is ok even with zero payments", () => {
    const inputs = baseInputs();
    inputs.ap = { open_cents: 8_000, paid_total_cents: 0, bills: 3 };
    const rows = buildTieoutRows(inputs);
    const r = rows.find((x) => x.account_code === "2000");
    expect(r.status).toBe("ok");
    expect(r.waived).toBeNull();
  });

  it("missing GL account id → subledger side reads 0 (surfaced via meta upstream)", () => {
    const inputs = baseInputs();
    inputs.accountIdByCode.delete("1105");
    const rows = buildTieoutRows(inputs);
    const r = rows.find((x) => x.account_code === "1105");
    expect(r.subledger_cents).toBe(0);
    expect(r.gl_cents).toBe(10_000);
    expect(r.status).toBe("break");
  });
});

// ── runControlTieouts with a chainable supabase double ────────────────────
// Each admin.from(table) call consumes the next queued response for that
// table; the builder is thenable and every filter method returns itself, so
// the double mirrors the real PostgREST chain (including .range pagination —
// a second page is a second from() call).
function makeAdmin(queues) {
  return {
    from(table) {
      const next = (queues[table] || []).shift() || { data: [], error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        not: () => chain,
        order: () => chain,
        range: () => chain,
        then: (resolve) => resolve(next),
      };
      return chain;
    },
  };
}

describe("runControlTieouts", () => {
  it("wires GL + AR + AP reads into tie-out rows and meta", async () => {
    const admin = makeAdmin({
      gl_accounts: [{
        data: [
          { id: "id-1105", code: "1105", name: "AR - Credit Card", is_control: true },
          { id: "id-1107", code: "1107", name: "AR - Factored", is_control: true },
          { id: "id-1108", code: "1108", name: "AR - House", is_control: true },
          { id: "id-2000", code: "2000", name: "Accounts Payable", is_control: true },
        ],
        error: null,
      }],
      v_trial_balance: [{
        data: [
          { code: "1108", debit_cents: 30000, credit_cents: 10000 },
          { code: "2000", debit_cents: 0, credit_cents: 7500 },
        ],
        error: null,
      }],
      ar_invoices: [{
        data: [
          { ar_account_id: "id-1108", total_amount_cents: 20_000, paid_amount_cents: 0 },
          { ar_account_id: null, total_amount_cents: 111, paid_amount_cents: 0 },
        ],
        error: null,
      }],
      invoices: [{
        data: [{ total_amount_cents: 7_500, paid_amount_cents: 0 }],
        error: null,
      }],
    });

    const { rows, meta } = await runControlTieouts(admin, "ent-1");
    expect(rows).toHaveLength(4);

    const r1108 = rows.find((r) => r.account_code === "1108");
    expect(r1108.gl_cents).toBe(20_000);
    expect(r1108.subledger_cents).toBe(20_000);
    expect(r1108.status).toBe("ok");

    const r1105 = rows.find((r) => r.account_code === "1105");
    expect(r1105.gl_cents).toBe(0);
    expect(r1105.status).toBe("ok");

    const r2000 = rows.find((r) => r.account_code === "2000");
    expect(r2000.gl_cents).toBe(7_500);
    expect(r2000.subledger_cents).toBe(7_500);
    expect(r2000.status).toBe("ok");

    expect(meta.ar_unmapped_cents).toBe(111);
    expect(meta.ap_posted_bills).toBe(1);
    expect(meta.ap_paid_total_cents).toBe(0);
    expect(meta.missing_accounts).toEqual([]);
    expect(meta.account_names["1107"]).toBe("AR - Factored");
  });

  it("throws loudly when a read fails", async () => {
    const admin = makeAdmin({
      gl_accounts: [{ data: null, error: { message: "boom" } }],
    });
    await expect(runControlTieouts(admin, "ent-1")).rejects.toThrow(/gl_accounts read failed: boom/);
  });

  it("reports control accounts missing from the chart", async () => {
    const admin = makeAdmin({
      gl_accounts: [{ data: [{ id: "id-2000", code: "2000", name: "AP", is_control: true }], error: null }],
      v_trial_balance: [{ data: [], error: null }],
      ar_invoices: [{ data: [], error: null }],
      invoices: [{ data: [], error: null }],
    });
    const { meta } = await runControlTieouts(admin, "ent-1");
    expect(meta.missing_accounts).toEqual(["1105", "1107", "1108"]);
  });
});
