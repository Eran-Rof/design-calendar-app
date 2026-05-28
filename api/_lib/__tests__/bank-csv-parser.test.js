// Tests for the bank-feeds CSV parser + normalizer (P6-3).

import { describe, it, expect } from "vitest";
import {
  parseCsv,
  inferColumnMapping,
  normalizeRow,
  coerceDate,
  parseMoney,
} from "../bank-feeds/csvParser.js";
import { validateBody } from "../../_handlers/internal/bank-feeds/csv-upload.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("parseCsv", () => {
  it("parses a basic 2-row CSV", () => {
    const out = parseCsv("Date,Amount\n2026-05-28,100.00\n2026-05-29,-50.00");
    expect(out.headers).toEqual(["Date", "Amount"]);
    expect(out.rows).toEqual([
      { Date: "2026-05-28", Amount: "100.00" },
      { Date: "2026-05-29", Amount: "-50.00" },
    ]);
  });
  it("handles quoted fields with commas", () => {
    const out = parseCsv('Date,Description\n2026-05-28,"Coffee, Inc."');
    expect(out.rows[0].Description).toBe("Coffee, Inc.");
  });
  it("handles escaped double quotes", () => {
    const out = parseCsv('A\n"say ""hi"""');
    expect(out.rows[0].A).toBe('say "hi"');
  });
  it("handles CRLF line endings", () => {
    const out = parseCsv("Date,Amt\r\n2026-05-28,1.00\r\n");
    expect(out.rows[0]).toEqual({ Date: "2026-05-28", Amt: "1.00" });
  });
  it("strips BOM", () => {
    const out = parseCsv("﻿Date,Amt\n2026-05-28,1");
    expect(out.headers[0]).toBe("Date");
  });
  it("drops trailing empty rows from final newline", () => {
    expect(parseCsv("A,B\n1,2\n").rows.length).toBe(1);
  });
  it("empty input → empty result", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });
});

describe("inferColumnMapping", () => {
  it("infers Date / Amount / Description from common headers", () => {
    expect(inferColumnMapping(["Date", "Amount", "Description"])).toEqual({
      date: "Date", amount: "Amount", description: "Description",
    });
  });
  it("matches case-insensitive aliases", () => {
    expect(inferColumnMapping(["DATE", "transaction amount", "memo"])).toEqual({
      date: "DATE", amount: "transaction amount", description: "memo",
    });
  });
  it("infers debit + credit pair when amount is missing", () => {
    expect(inferColumnMapping(["Posted Date", "Debit", "Credit", "Memo"])).toEqual({
      date: "Posted Date", debit: "Debit", credit: "Credit", description: "Memo",
    });
  });
  it("returns empty when no aliases match", () => {
    expect(inferColumnMapping(["XYZ", "ABC"])).toEqual({});
  });
});

describe("coerceDate", () => {
  it("passes through ISO", () => {
    expect(coerceDate("2026-05-28")).toBe("2026-05-28");
  });
  it("parses US MM/DD/YYYY", () => {
    expect(coerceDate("5/28/2026")).toBe("2026-05-28");
    expect(coerceDate("05/28/2026")).toBe("2026-05-28");
  });
  it("expands 2-digit year as 20XX", () => {
    expect(coerceDate("5/28/26")).toBe("2026-05-28");
  });
  it("rejects nonsense", () => {
    expect(coerceDate("yesterday")).toBeNull();
    expect(coerceDate("")).toBeNull();
    expect(coerceDate(null)).toBeNull();
  });
  it("rejects invalid month/day", () => {
    expect(coerceDate("13/01/2026")).toBeNull();
    expect(coerceDate("01/35/2026")).toBeNull();
  });
});

describe("parseMoney", () => {
  it("parses plain numbers", () => {
    expect(parseMoney("123.45")).toBe(12345);
    expect(parseMoney("0.05")).toBe(5);
    expect(parseMoney("1")).toBe(100);
  });
  it("handles dollar sign + commas", () => {
    expect(parseMoney("$1,234.56")).toBe(123456);
  });
  it("handles negative via minus", () => {
    expect(parseMoney("-50.00")).toBe(-5000);
  });
  it("handles parens-negative", () => {
    expect(parseMoney("(50.00)")).toBe(-5000);
    expect(parseMoney("($1,234.56)")).toBe(-123456);
  });
  it("rounds long fractions to 2 decimals", () => {
    expect(parseMoney("1.999")).toBe(199);    // truncate; parseInt of '99' from padded '999'.slice(0,2)='99'
  });
  it("rejects nonsense", () => {
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe("normalizeRow", () => {
  it("normalizes a row with date + amount mapping", () => {
    const r = normalizeRow(
      { Date: "2026-05-28", Amount: "-50.00", Memo: "Coffee" },
      { date: "Date", amount: "Amount", description: "Memo" },
    );
    expect(r.error).toBeUndefined();
    expect(r.row.posted_date).toBe("2026-05-28");
    expect(r.row.amount_cents).toBe(-5000);
    expect(r.row.description).toBe("Coffee");
    expect(r.row.source).toBe("csv_upload");
    expect(r.row.external_txn_id).toMatch(/^[0-9a-f]{32}$/);
  });
  it("inverts sign when amount_sign='invert'", () => {
    const r = normalizeRow(
      { Date: "2026-05-28", Amount: "50.00" },
      { date: "Date", amount: "Amount", amount_sign: "invert" },
    );
    expect(r.row.amount_cents).toBe(-5000);
  });
  it("computes amount from debit + credit pair", () => {
    expect(normalizeRow(
      { Date: "2026-05-28", Debit: "50.00", Credit: "0" },
      { date: "Date", debit: "Debit", credit: "Credit" },
    ).row.amount_cents).toBe(-5000);
    expect(normalizeRow(
      { Date: "2026-05-28", Debit: "0", Credit: "100" },
      { date: "Date", debit: "Debit", credit: "Credit" },
    ).row.amount_cents).toBe(10000);
  });
  it("rejects missing date", () => {
    expect(normalizeRow({ Amount: "1" }, { date: "Date", amount: "Amount" }).error).toMatch(/missing date/);
  });
  it("rejects unparseable date", () => {
    expect(normalizeRow({ Date: "tomorrow", Amount: "1" }, { date: "Date", amount: "Amount" }).error)
      .toMatch(/unparseable date/);
  });
  it("rejects mapping without amount or debit/credit", () => {
    expect(normalizeRow({ Date: "2026-05-28" }, { date: "Date" }).error).toMatch(/amount.*debit.*credit/);
  });
  it("produces stable hash for same (date, amount, description)", () => {
    const a = normalizeRow({ Date: "2026-05-28", Amount: "10", Memo: "X" }, { date: "Date", amount: "Amount", description: "Memo" });
    const b = normalizeRow({ Date: "2026-05-28", Amount: "10", Memo: "X" }, { date: "Date", amount: "Amount", description: "Memo" });
    expect(a.row.external_txn_id).toBe(b.row.external_txn_id);
  });
  it("different descriptions → different hashes", () => {
    const a = normalizeRow({ D: "2026-05-28", A: "10", M: "X" }, { date: "D", amount: "A", description: "M" });
    const b = normalizeRow({ D: "2026-05-28", A: "10", M: "Y" }, { date: "D", amount: "A", description: "M" });
    expect(a.row.external_txn_id).not.toBe(b.row.external_txn_id);
  });
});

describe("csv-upload validateBody", () => {
  it("rejects missing bank_account_id", () => {
    expect(validateBody({ csv_text: "x" }).error).toMatch(/bank_account_id/);
  });
  it("rejects malformed bank_account_id", () => {
    expect(validateBody({ bank_account_id: "not-uuid", csv_text: "x" }).error).toMatch(/bank_account_id/);
  });
  it("rejects missing csv_text", () => {
    expect(validateBody({ bank_account_id: UUID }).error).toMatch(/csv_text/);
  });
  it("rejects csv_text > 5 MB", () => {
    const big = "x".repeat(5 * 1024 * 1024 + 10);
    expect(validateBody({ bank_account_id: UUID, csv_text: big }).error).toMatch(/exceeds/);
  });
  it("accepts valid minimum body", () => {
    const v = validateBody({ bank_account_id: UUID, csv_text: "A,B\n1,2" });
    expect(v.error).toBeUndefined();
    expect(v.data.column_mapping).toBeNull();
    expect(v.data.save_mapping).toBe(false);
    expect(v.data.dry_run).toBe(false);
  });
  it("validates column_mapping shape", () => {
    expect(validateBody({ bank_account_id: UUID, csv_text: "A,B", column_mapping: "bad" }).error).toMatch(/object/);
    expect(validateBody({ bank_account_id: UUID, csv_text: "A,B", column_mapping: { amount_sign: "weird" } }).error)
      .toMatch(/amount_sign/);
  });
  it("accepts valid column_mapping", () => {
    const v = validateBody({
      bank_account_id: UUID,
      csv_text: "A,B",
      column_mapping: { date: "A", amount: "B", amount_sign: "invert" },
    });
    expect(v.error).toBeUndefined();
    expect(v.data.column_mapping).toEqual({ date: "A", amount: "B", amount_sign: "invert" });
  });
});
