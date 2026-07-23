import { describe, it, expect } from "vitest";
import {
  ENRICHED_PREFIXES,
  enrichedKeyOrFilter,
  isEnrichedKey,
  distinctInvoiceNumbers,
  partitionEnriched,
  fetchEnrichedInvoiceSet,
} from "../salesEnrichGuard.js";

describe("isEnrichedKey", () => {
  it("matches every enrichment prefix and rejects colour keys", () => {
    expect(isEnrichedKey("excel:size:ROF-I148830:uuid:20")).toBe(true);
    expect(isEnrichedKey("excel:reprice:ROF-I013737:uuid:0")).toBe(true);
    expect(isEnrichedKey("excel:fill:ROF-I006585:uuid:1")).toBe(true);
    expect(isEnrichedKey("excel:relink:ROF-I000001:uuid:2")).toBe(true);
    expect(isEnrichedKey("excel:inv:ROF-I148830:RYB0412-BLACK:2026-04-09")).toBe(false);
    expect(isEnrichedKey("excel:RYB0412:2026-04-09:100")).toBe(false);
    expect(isEnrichedKey(null)).toBe(false);
  });
});

describe("enrichedKeyOrFilter", () => {
  it("builds one like clause per prefix with * wildcards", () => {
    const f = enrichedKeyOrFilter();
    expect(f.split(",")).toHaveLength(ENRICHED_PREFIXES.length);
    expect(f).toContain("source_line_key.like.excel:size:*");
    expect(f).not.toContain("%");
  });
});

describe("distinctInvoiceNumbers", () => {
  it("dedupes, trims, and drops empty/null", () => {
    const rows = [
      { invoice_number: "ROF-I1" },
      { invoice_number: " ROF-I1 " },
      { invoice_number: "ROF-I2" },
      { invoice_number: null },
      { invoice_number: "" },
      {},
    ];
    expect(distinctInvoiceNumbers(rows).sort()).toEqual(["ROF-I1", "ROF-I2"]);
  });
});

describe("partitionEnriched", () => {
  it("skips rows on enriched invoices, keeps everything else incl. no-invoice rows", () => {
    const rows = [
      { invoice_number: "ROF-I1", qty: 1 },
      { invoice_number: "ROF-I2", qty: 2 },
      { invoice_number: null, qty: 3 },     // ship row — always kept
      { invoice_number: "ROF-I1", qty: 4 },
    ];
    const { kept, skipped } = partitionEnriched(rows, new Set(["ROF-I1"]));
    expect(kept.map((r) => r.qty)).toEqual([2, 3]);
    expect(skipped.map((r) => r.qty)).toEqual([1, 4]);
  });

  it("empty enriched set keeps all rows", () => {
    const rows = [{ invoice_number: "ROF-I1" }];
    const { kept, skipped } = partitionEnriched(rows, new Set());
    expect(kept).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });
});

function mockAdmin(pages) {
  // pages: array of {data, error} returned per .or() call in order
  let call = 0;
  const calls = [];
  return {
    calls,
    from() { return this; },
    select() { return this; },
    in(_col, chunk) { calls.push(chunk); return this; },
    or() { return Promise.resolve(pages[call++] ?? { data: [], error: null }); },
  };
}

describe("fetchEnrichedInvoiceSet", () => {
  it("chunks the in-list and unions the results", async () => {
    const invoices = Array.from({ length: 450 }, (_, i) => `ROF-I${i}`);
    const admin = mockAdmin([
      { data: [{ invoice_number: "ROF-I3" }], error: null },
      { data: [{ invoice_number: "ROF-I250" }, { invoice_number: "ROF-I3" }], error: null },
      { data: [], error: null },
    ]);
    const found = await fetchEnrichedInvoiceSet(admin, invoices, { chunkSize: 200 });
    expect(admin.calls).toHaveLength(3);
    expect(admin.calls[0]).toHaveLength(200);
    expect(admin.calls[2]).toHaveLength(50);
    expect(Array.from(found).sort()).toEqual(["ROF-I250", "ROF-I3"]);
  });

  it("fail-open: a chunk error is recorded and remaining chunks still run", async () => {
    const admin = mockAdmin([
      { data: null, error: { message: "boom" } },
      { data: [{ invoice_number: "ROF-I9" }], error: null },
    ]);
    const errors = [];
    const found = await fetchEnrichedInvoiceSet(admin, ["A", "B"], { chunkSize: 1, errors });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("boom");
    expect(found.has("ROF-I9")).toBe(true);
  });
});
