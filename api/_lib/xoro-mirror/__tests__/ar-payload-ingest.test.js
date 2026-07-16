import { describe, it, expect } from "vitest";
import {
  invoiceNumberOf,
  invoiceNumbersFromPayloadRows,
  sweepOpenInvoicePayloads,
} from "../ar-payload-ingest.js";

function inv(num) {
  return { invoiceHeader: { InvoiceNumber: num, StatusName: "Open" }, invoiceItemLineArr: [{ ItemNumber: `SKU-${num}`, Qty: 1, TotalAmount: 10 }] };
}

describe("invoiceNumberOf / invoiceNumbersFromPayloadRows", () => {
  it("reads InvoiceNumber off the header", () => {
    expect(invoiceNumberOf(inv("ROF-I1"))).toBe("ROF-I1");
    expect(invoiceNumberOf({ invoiceHeader: {} })).toBeNull();
  });
  it("extracts the set across batch rows", () => {
    const rows = [{ payload: { data: [inv("A"), inv("B")] } }, { payload: { data: [inv("B"), inv("C")] } }];
    expect(invoiceNumbersFromPayloadRows(rows)).toEqual(new Set(["A", "B", "C"]));
  });
});

describe("sweepOpenInvoicePayloads", () => {
  function makeFetch(pagesData, totalPages) {
    return async (page) => {
      const records = pagesData[page - 1] || [];
      return { ok: true, records, totalPages, status: 200 };
    };
  }
  function makeInsert(sink) {
    return async (_admin, args) => {
      sink.push(args);
      return { id: `row-${sink.length}`, deduped: false };
    };
  }

  it("archives only NEW invoices, batching by batchSize, and stops at totalPages", async () => {
    const pages = [[inv("A"), inv("B")], [inv("C"), inv("D")]];
    const writes = [];
    const summary = await sweepOpenInvoicePayloads(
      { fetchPage: makeFetch(pages, 2), admin: {}, insertRaw: makeInsert(writes), loadKnown: async () => new Set(["A"]) },
      { batchSize: 2, pageDelayMs: 0, flushDelayMs: 0 },
    );
    expect(summary.invoices_seen).toBe(4);
    expect(summary.invoices_new).toBe(3); // B, C, D (A known)
    expect(summary.invoices_known_skipped).toBe(1);
    expect(summary.stopped_reason).toBe("reached_total_pages");
    // 3 new invoices, batchSize 2 → one full batch (2) flushed mid-walk + final flush (1) = 2 rows
    expect(summary.rows_written).toBe(2);
    const allNums = writes.flatMap((w) => w.payload.data.map(invoiceNumberOf));
    expect(allNums).toEqual(["B", "C", "D"]);
    expect(writes[0].endpoint).toBe("sales-history");
    // Slim contract: the number list rides at payload.invoice_numbers (the
    // known-set fast path selects only that key) and archived records are
    // whitelisted slices.
    expect(writes[0].payload.invoice_numbers).toEqual(["B", "C"]);
    expect(writes[0].params.slim).toBe(true);
    expect(writes[0].payload.data[0].invoiceHeader).toEqual({ InvoiceNumber: "B", StatusName: "Open" });
    expect(writes[0].payload.data[0].invoiceItemLineArr).toEqual([{ ItemNumber: "SKU-B", Qty: 1, TotalAmount: 10 }]);
  });

  it("slimInvoiceRecord drops unlisted fields but keeps the explosion-feed cascade", async () => {
    const { slimInvoiceRecord } = await import("../ar-payload-ingest.js");
    const fat = {
      invoiceHeader: { InvoiceNumber: "X", CustomFieldH1: "junk", BillToAddr: "junk", TxnDate: "07/01/2026", StatusName: "Open" },
      invoiceItemLineArr: [{ ItemNumber: "STY-BLK-LRG", Qty: 3, UnitPrice: 7.5, TotalAmount: 22.5, Discount: 0, Id: 9, ReportDataObj: "junk" }],
    };
    const slim = slimInvoiceRecord(fat);
    expect(slim.invoiceHeader).toEqual({ InvoiceNumber: "X", TxnDate: "07/01/2026", StatusName: "Open" });
    expect(slim.invoiceItemLineArr).toEqual([{ ItemNumber: "STY-BLK-LRG", Qty: 3, UnitPrice: 7.5, TotalAmount: 22.5, Discount: 0, Id: 9 }]);
  });

  it("is idempotent: a re-run where everything is known writes nothing", async () => {
    const pages = [[inv("A"), inv("B")]];
    const writes = [];
    const summary = await sweepOpenInvoicePayloads(
      { fetchPage: makeFetch(pages, 1), admin: {}, insertRaw: makeInsert(writes), loadKnown: async () => new Set(["A", "B"]) },
      { pageDelayMs: 0 },
    );
    expect(summary.invoices_new).toBe(0);
    expect(summary.rows_written).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("stops on an empty page and records the reason", async () => {
    const pages = [[inv("A")], []];
    const writes = [];
    const summary = await sweepOpenInvoicePayloads(
      { fetchPage: makeFetch(pages, 99), admin: {}, insertRaw: makeInsert(writes), loadKnown: async () => new Set() },
      { pageDelayMs: 0 },
    );
    expect(summary.stopped_reason).toBe("empty_page");
    expect(summary.invoices_new).toBe(1);
  });

  it("halts and reports when a page fetch fails", async () => {
    const writes = [];
    const summary = await sweepOpenInvoicePayloads(
      { fetchPage: async () => ({ ok: false, status: 500 }), admin: {}, insertRaw: makeInsert(writes), loadKnown: async () => new Set() },
      { pageDelayMs: 0 },
    );
    expect(summary.stopped_reason).toBe("fetch_failed");
    expect(summary.errors.length).toBe(1);
  });

  it("tail mode: probes page 1 then walks only the last N pages", async () => {
    // 6 pages of 1 invoice each; tailPages=2 → walk page 1 (probe) + pages 5,6.
    const pages = [[inv("P1")], [inv("P2")], [inv("P3")], [inv("P4")], [inv("P5")], [inv("P6")]];
    const writes = [];
    const fetched = [];
    const fetchPage = async (page) => { fetched.push(page); return { ok: true, records: pages[page - 1] || [], totalPages: 6, status: 200 }; };
    const summary = await sweepOpenInvoicePayloads(
      { fetchPage, admin: {}, insertRaw: makeInsert(writes), loadKnown: async () => new Set() },
      { tailPages: 2, pageDelayMs: 0, flushDelayMs: 0 },
    );
    expect(summary.mode).toBe("tail");
    expect(fetched).toEqual([1, 5, 6]);
    expect(summary.invoices_new).toBe(3); // P1 (probe) + P5 + P6
    expect(summary.stopped_reason).toBe("tail_complete");
    const allNums = writes.flatMap((w) => w.payload.data.map(invoiceNumberOf));
    expect(allNums).toEqual(["P1", "P5", "P6"]);
  });

  it("tail mode: single-page universe stops after the probe", async () => {
    const writes = [];
    const fetchPage = async () => ({ ok: true, records: [inv("ONLY")], totalPages: 1, status: 200 });
    const summary = await sweepOpenInvoicePayloads(
      { fetchPage, admin: {}, insertRaw: makeInsert(writes), loadKnown: async () => new Set() },
      { tailPages: 4, pageDelayMs: 0, flushDelayMs: 0 },
    );
    expect(summary.stopped_reason).toBe("single_page");
    expect(summary.invoices_new).toBe(1);
    expect(writes).toHaveLength(1);
  });
});
