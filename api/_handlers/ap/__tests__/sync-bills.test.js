// Tests for /api/ap/sync-bills — Xoro AP-bill mirror ingest.
//
// Exercises:
//   • The exported buildCandidates() parser/dedupe logic (no HTTP, no
//     formidable, no supabase) — covers row-level branches like missing
//     bill_number, missing date, zero qty.
//   • The full handler via vi.mock to stub formidable + supabase, covering
//     idempotency (same payload twice → no dupes).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as XLSX from "xlsx";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ── makeRes / makeReq helpers ─────────────────────────────────────────────
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  return res;
}

// Build a CSV file on disk that mimics what the producer POSTs (just the
// inner CSV, not gzipped — decompressIfGzipped will pass it through).
function writeCsv(rows, headerOrder) {
  const headers = headerOrder ?? [
    "Bill Number", "Bill Date", "Due Date", "Vendor Code", "Vendor Name", "Currency",
    "Item Number", "Description", "Qty", "Unit Price", "Amount",
    "Bill Status", "Payment Status",
  ];
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  const csv = XLSX.utils.sheet_to_csv(ws);
  const dir = mkdtempSync(join(tmpdir(), "ap-bills-test-"));
  const path = join(dir, "bills.csv");
  writeFileSync(path, csv);
  return { path, dir };
}

// ── buildCandidates — direct unit tests ───────────────────────────────────
describe("ap/sync-bills buildCandidates", () => {
  let buildCandidates;
  beforeEach(async () => {
    const mod = await import("../sync-bills.js");
    buildCandidates = mod.buildCandidates;
  });

  it("returns 0 candidates on empty CSV", () => {
    const { rows, counts } = buildCandidates([]);
    expect(rows).toEqual([]);
    expect(counts.csv_rows).toBe(0);
  });

  it("emits 2 rows with distinct source_line_key for one bill with 2 lines", () => {
    const csv = [
      {
        "Bill Number": "BILL-1", "Bill Date": "2026-06-01", "Due Date": "2026-07-01",
        "Vendor Code": "V1", "Vendor Name": "Acme", "Currency": "USD",
        "Item Number": "SKU-A", "Description": "Widget A", "Qty": 10,
        "Unit Price": 5, "Amount": 50, "Bill Status": "Open", "Payment Status": "Unpaid",
      },
      {
        "Bill Number": "BILL-1", "Bill Date": "2026-06-01", "Due Date": "2026-07-01",
        "Vendor Code": "V1", "Vendor Name": "Acme", "Currency": "USD",
        "Item Number": "SKU-B", "Description": "Widget B", "Qty": 3,
        "Unit Price": 10, "Amount": 30, "Bill Status": "Open", "Payment Status": "Unpaid",
      },
    ];
    const { rows, counts } = buildCandidates(csv);
    expect(rows).toHaveLength(2);
    const keys = new Set(rows.map(r => r.source_line_key));
    expect(keys.size).toBe(2);
    expect(rows[0].source_line_key).toBe("BILL-1::SKU-A::0");
    expect(rows[1].source_line_key).toBe("BILL-1::SKU-B::1");
    expect(rows[0].bill_number).toBe("BILL-1");
    expect(rows[0].qty).toBe(10);
    expect(rows[0].source).toBe("xoro");
    expect(counts.skipped_no_bill_number).toBe(0);
    expect(counts.skipped_no_date).toBe(0);
  });

  it("counts row missing bill_number in skipped_no_bill_number", () => {
    const csv = [
      {
        "Bill Number": "", "Bill Date": "2026-06-01",
        "Item Number": "SKU-A", "Qty": 1, "Unit Price": 5, "Amount": 5,
      },
      {
        "Bill Number": "BILL-2", "Bill Date": "2026-06-02",
        "Item Number": "SKU-X", "Qty": 1, "Unit Price": 5, "Amount": 5,
      },
    ];
    const { rows, counts } = buildCandidates(csv);
    expect(counts.skipped_no_bill_number).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].bill_number).toBe("BILL-2");
  });

  it("counts row missing date in skipped_no_date", () => {
    const csv = [
      {
        "Bill Number": "BILL-3", "Bill Date": "",
        "Item Number": "SKU-A", "Qty": 1, "Unit Price": 5, "Amount": 5,
      },
      {
        "Bill Number": "BILL-4", "Bill Date": "2026-06-02",
        "Item Number": "SKU-X", "Qty": 1, "Unit Price": 5, "Amount": 5,
      },
    ];
    const { rows, counts } = buildCandidates(csv);
    expect(counts.skipped_no_date).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].bill_number).toBe("BILL-4");
  });

  it("counts zero-qty row in skipped_zero_qty", () => {
    const csv = [
      {
        "Bill Number": "BILL-5", "Bill Date": "2026-06-01",
        "Item Number": "SKU-A", "Qty": 0, "Unit Price": 0, "Amount": 0,
      },
      {
        "Bill Number": "BILL-5", "Bill Date": "2026-06-01",
        "Item Number": "SKU-B", "Qty": 2, "Unit Price": 5, "Amount": 10,
      },
    ];
    const { rows, counts } = buildCandidates(csv);
    expect(counts.skipped_zero_qty).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].item_number).toBe("SKU-B");
  });

  it("handles expense lines without item_number using empty segment + line_index", () => {
    const csv = [
      {
        "Bill Number": "BILL-6", "Bill Date": "2026-06-01",
        "Item Number": "", "Description": "Freight", "Qty": 1, "Unit Price": 50, "Amount": 50,
      },
      {
        "Bill Number": "BILL-6", "Bill Date": "2026-06-01",
        "Item Number": "", "Description": "Broker fee", "Qty": 1, "Unit Price": 25, "Amount": 25,
      },
    ];
    const { rows } = buildCandidates(csv);
    expect(rows).toHaveLength(2);
    const keys = rows.map(r => r.source_line_key);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe("BILL-6::::0");
    expect(keys[1]).toBe("BILL-6::::1");
  });
});

// ── Full handler — mocked formidable + supabase ───────────────────────────
let upsertSpy;

vi.mock("formidable", () => {
  return {
    default: () => ({
      parse: async (req) => {
        // The mock just returns whatever files were stuffed onto the req.
        return [{}, req.__files];
      },
    }),
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from(table) {
      expect(table).toBe("ap_bills");
      return {
        upsert(rows, opts) {
          upsertSpy(rows, opts);
          return Promise.resolve({ error: null });
        },
      };
    },
  })),
}));

describe("ap/sync-bills handler", () => {
  let handler;
  let tmpDir;

  beforeEach(async () => {
    process.env.DESIGN_CALENDAR_API_TOKEN = TOKEN;
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { _resetRateLimitForTests } = await import("../../../_lib/auth.js");
    _resetRateLimitForTests();
    upsertSpy = vi.fn();
    handler = (await import("../sync-bills.js")).default;
  });

  afterEach(() => {
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} tmpDir = null; }
    vi.clearAllMocks();
  });

  function makeReqWithCsv(rows) {
    const { path, dir } = writeCsv(rows);
    tmpDir = dir;
    return {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      url: "/api/ap/sync-bills",
      __files: {
        bills: { filepath: path, originalFilename: "bills.csv" },
      },
    };
  }

  it("returns 200 with zero upserted on empty CSV", async () => {
    const req = makeReqWithCsv([]);
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.upserted).toBe(0);
    expect(res.body.csv_rows).toBe(0);
    expect(res.body.mode).toBe("incremental");
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("upserts 2 rows for one bill with 2 line items", async () => {
    const req = makeReqWithCsv([
      {
        "Bill Number": "BILL-100", "Bill Date": "2026-06-01", "Due Date": "2026-07-01",
        "Vendor Code": "V1", "Vendor Name": "Acme", "Currency": "USD",
        "Item Number": "SKU-A", "Description": "A", "Qty": 5,
        "Unit Price": 10, "Amount": 50, "Bill Status": "Open", "Payment Status": "Unpaid",
      },
      {
        "Bill Number": "BILL-100", "Bill Date": "2026-06-01", "Due Date": "2026-07-01",
        "Vendor Code": "V1", "Vendor Name": "Acme", "Currency": "USD",
        "Item Number": "SKU-B", "Description": "B", "Qty": 2,
        "Unit Price": 25, "Amount": 50, "Bill Status": "Open", "Payment Status": "Unpaid",
      },
    ]);
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.upserted).toBe(2);
    expect(upsertSpy).toHaveBeenCalledOnce();
    const [chunk, opts] = upsertSpy.mock.calls[0];
    expect(chunk).toHaveLength(2);
    expect(opts).toEqual({ onConflict: "source,source_line_key", ignoreDuplicates: false });
    const keys = new Set(chunk.map(r => r.source_line_key));
    expect(keys.size).toBe(2);
  });

  it("is idempotent — same payload posted twice produces the same row count", async () => {
    const payload = [
      {
        "Bill Number": "BILL-200", "Bill Date": "2026-06-01", "Due Date": "2026-07-01",
        "Vendor Code": "V1", "Vendor Name": "Acme", "Currency": "USD",
        "Item Number": "SKU-A", "Description": "A", "Qty": 5,
        "Unit Price": 10, "Amount": 50, "Bill Status": "Open", "Payment Status": "Unpaid",
      },
      {
        "Bill Number": "BILL-200", "Bill Date": "2026-06-01", "Due Date": "2026-07-01",
        "Vendor Code": "V1", "Vendor Name": "Acme", "Currency": "USD",
        "Item Number": "SKU-B", "Description": "B", "Qty": 2,
        "Unit Price": 25, "Amount": 50, "Bill Status": "Open", "Payment Status": "Unpaid",
      },
    ];

    const req1 = makeReqWithCsv(payload);
    const res1 = makeRes();
    await handler(req1, res1);
    const firstUpsertCall = upsertSpy.mock.calls[0];
    const firstKeys = firstUpsertCall[0].map(r => r.source_line_key).sort();
    expect(res1.body.upserted).toBe(2);

    // Fresh files dir for the 2nd request (formidable would normally
    // have written to a new temp path).
    const req2 = makeReqWithCsv(payload);
    const res2 = makeRes();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.upserted).toBe(2);

    const secondUpsertCall = upsertSpy.mock.calls[1];
    const secondKeys = secondUpsertCall[0].map(r => r.source_line_key).sort();

    // The actual idempotency guarantee — same payload yields the SAME
    // source_line_key set, so the database upsert will hit the same rows
    // (no duplicates created).
    expect(secondKeys).toEqual(firstKeys);
  });

  it("counts skipped_no_bill_number when bill_number is blank", async () => {
    const req = makeReqWithCsv([
      {
        "Bill Number": "", "Bill Date": "2026-06-01",
        "Item Number": "SKU-A", "Qty": 1, "Unit Price": 5, "Amount": 5,
      },
      {
        "Bill Number": "BILL-300", "Bill Date": "2026-06-02",
        "Item Number": "SKU-X", "Qty": 1, "Unit Price": 5, "Amount": 5,
      },
    ]);
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.skipped_no_bill_number).toBe(1);
    expect(res.body.upserted).toBe(1);
  });

  it("counts skipped_no_date when Bill Date is blank", async () => {
    const req = makeReqWithCsv([
      {
        "Bill Number": "BILL-400", "Bill Date": "",
        "Item Number": "SKU-A", "Qty": 1, "Unit Price": 5, "Amount": 5,
      },
      {
        "Bill Number": "BILL-401", "Bill Date": "2026-06-02",
        "Item Number": "SKU-X", "Qty": 1, "Unit Price": 5, "Amount": 5,
      },
    ]);
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.skipped_no_date).toBe(1);
    expect(res.body.upserted).toBe(1);
  });

  it("returns 401 when bearer token is missing", async () => {
    const req = { method: "POST", headers: {}, url: "/api/ap/sync-bills", __files: {} };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("returns 405 for GET", async () => {
    const req = { method: "GET", headers: { authorization: `Bearer ${TOKEN}` }, url: "/api/ap/sync-bills" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 for OPTIONS (CORS preflight)", async () => {
    const req = { method: "OPTIONS", headers: {}, url: "/api/ap/sync-bills" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
  });

  it("returns 400 when no file is attached", async () => {
    const req = {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      url: "/api/ap/sync-bills",
      __files: {},
    };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Missing 'bills'/);
  });
});
