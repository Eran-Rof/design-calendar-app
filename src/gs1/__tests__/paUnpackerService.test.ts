import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  PA_CHANNEL_KEYS,
  PA_SIZE_ORDER,
  paSizeRank,
  comparePaSizes,
  paDateSortKey,
  uniqueChannelDateCombos,
  sizesPresent,
  aggregateVerifyAllOk,
  flattenRecords,
  summarizeRecords,
  parsePAWorkbook,
} from "../services/paUnpackerService";
import type { PARecord } from "../services/paUnpackerService";

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("paSizeRank / comparePaSizes", () => {
  it("ranks known sizes by canonical order", () => {
    expect(paSizeRank("12M")).toBe(0);
    expect(paSizeRank("5T")).toBe(5);
    expect(paSizeRank("5")).toBe(6);
    expect(paSizeRank("20")).toBe(15);
    expect(paSizeRank("XS 5-6")).toBe(16);
    expect(paSizeRank("XL 18-20")).toBe(20);
  });

  it("returns 999 for unknown sizes", () => {
    expect(paSizeRank("9X")).toBe(999);
  });

  it("orders sizes correctly: toddler before numeric before set", () => {
    const sizes = ["XL 18-20", "5", "12M", "3T", "10", "S 7-8"];
    const sorted = [...sizes].sort(comparePaSizes);
    expect(sorted).toEqual(["12M", "3T", "5", "10", "S 7-8", "XL 18-20"]);
  });

  it("falls back to alphabetical for two unknown sizes", () => {
    expect(comparePaSizes("ZZZ", "AAA")).toBeGreaterThan(0);
  });
});

describe("paDateSortKey", () => {
  it("parses MM/DD/YY into [year, month, day]", () => {
    expect(paDateSortKey("02/01/27")).toEqual([27, 2, 1]);
    expect(paDateSortKey("11/30/26")).toEqual([26, 11, 30]);
  });

  it("returns sentinel tuple for bad input", () => {
    expect(paDateSortKey("not a date")).toEqual([9999, 99, 99]);
    expect(paDateSortKey("")).toEqual([9999, 99, 99]);
  });

  it("sorts dates by year, then month, then day", () => {
    const dates = ["02/01/27", "11/30/26", "01/04/27"];
    const sorted = [...dates].sort((a, b) => {
      const ka = paDateSortKey(a);
      const kb = paDateSortKey(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      return ka[2] - kb[2];
    });
    expect(sorted).toEqual(["11/30/26", "01/04/27", "02/01/27"]);
  });
});

describe("PA_CHANNEL_KEYS / PA_SIZE_ORDER", () => {
  it("exposes the canonical channel keys", () => {
    expect(PA_CHANNEL_KEYS).toEqual(["HAF", "MDC", "MDS"]);
  });

  it("exposes the full canonical size order", () => {
    expect(PA_SIZE_ORDER[0]).toBe("12M");
    expect(PA_SIZE_ORDER).toContain("5T");
    expect(PA_SIZE_ORDER).toContain("M 10-12");
    expect(PA_SIZE_ORDER[PA_SIZE_ORDER.length - 1]).toBe("XL 18-20");
  });
});

// ── Aggregation helpers ───────────────────────────────────────────────────────

function rec(over: Partial<PARecord> = {}): PARecord {
  return {
    file: "f.xls",
    sheet: "s",
    style: "100100100GK",
    style_desc: "DESC",
    gender: "GIRLS",
    color: "RED",
    channel: "MDC",
    size: "10",
    units: 12,
    indc_date: "02/01/27",
    ...over,
  };
}

describe("uniqueChannelDateCombos", () => {
  it("returns unique sorted (date, channel) combos", () => {
    const records = [
      rec({ channel: "MDS", indc_date: "02/01/27" }),
      rec({ channel: "MDC", indc_date: "02/01/27" }),
      rec({ channel: "HAF", indc_date: "11/30/26" }),
      rec({ channel: "MDC", indc_date: "02/01/27" }), // dup
    ];
    const out = uniqueChannelDateCombos(records);
    expect(out).toEqual([
      { channel: "HAF", indc_date: "11/30/26" },
      { channel: "MDC", indc_date: "02/01/27" },
      { channel: "MDS", indc_date: "02/01/27" },
    ]);
  });
});

describe("sizesPresent", () => {
  it("returns sizes seen in records, sorted canonically", () => {
    const records = [
      rec({ size: "20" }),
      rec({ size: "5" }),
      rec({ size: "12M" }),
      rec({ size: "10" }),
      rec({ size: "5" }),
    ];
    expect(sizesPresent(records)).toEqual(["12M", "5", "10", "20"]);
  });
});

describe("summarizeRecords", () => {
  it("counts records, distinct styles, distinct combos", () => {
    const records = [
      rec({ style: "A", channel: "MDC", indc_date: "02/01/27" }),
      rec({ style: "A", channel: "MDS", indc_date: "02/01/27" }),
      rec({ style: "B", channel: "MDC", indc_date: "11/30/26" }),
    ];
    expect(summarizeRecords(records)).toEqual({
      recordCount: 3,
      styleCount: 2,
      comboCount: 3,
    });
  });
});

describe("aggregateVerifyAllOk", () => {
  it("returns mismatches separately", () => {
    const parsed = [
      {
        fileName: "f.xls",
        records: [],
        errors: [],
        checks: [
          { file: "f.xls", sheet: "s1", channel: "MDC" as const, computed: 100, reported: 100, ok: true },
          { file: "f.xls", sheet: "s1", channel: "MDS" as const, computed: 99,  reported: 100, ok: false },
        ],
      },
    ];
    const out = aggregateVerifyAllOk(parsed);
    expect(out.total).toBe(2);
    expect(out.passed).toBe(1);
    expect(out.mismatches.length).toBe(1);
    expect(out.mismatches[0].channel).toBe("MDS");
  });
});

describe("flattenRecords", () => {
  it("concatenates records from multiple files", () => {
    const parsed = [
      { fileName: "a", records: [rec({ style: "A" })], checks: [], errors: [] },
      { fileName: "b", records: [rec({ style: "B" }), rec({ style: "C" })], checks: [], errors: [] },
    ];
    const flat = flattenRecords(parsed);
    expect(flat.map(r => r.style)).toEqual(["A", "B", "C"]);
  });
});

// ── Integration: real PA workbooks ────────────────────────────────────────────
//
// These tests only run when the 4 sample PA files exist on the host machine.
// CI / fresh checkouts skip them gracefully.

const DOWNLOADS = path.join(os.homedir(), "Downloads");
const SAMPLES = [
  "Q1 27 KID GIRL EPIC PA ROF.xls",
  "Q4 KID GIRL EPIC PA - Ring of Fire 5.1.xls",
  "KID EPIC BOYS Q1 Flows from Q4 ROF PA.xls",
  "TDLR EPIC BOYS Q1 Flows from Q4 ROF PA.xls",
];

const allSamplesPresent = SAMPLES.every(f => fs.existsSync(path.join(DOWNLOADS, f)));

(allSamplesPresent ? describe : describe.skip)("parsePAWorkbook — sample files", () => {
  function readFile(name: string): ArrayBuffer {
    const buf = fs.readFileSync(path.join(DOWNLOADS, name));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  it("parses all 4 sample files to the expected aggregate", () => {
    const parsed = SAMPLES.map(name => parsePAWorkbook(readFile(name), { fileName: name }));
    const all = flattenRecords(parsed);
    const summary = summarizeRecords(all);
    const verify = aggregateVerifyAllOk(parsed);

    expect(summary.recordCount).toBe(324);
    expect(summary.styleCount).toBe(16);
    expect(summary.comboCount).toBe(10);
    expect(verify.mismatches).toEqual([]);
  });

  it("Q1 KID GIRL sample: every sheet has master_item from R3:15", () => {
    const file = SAMPLES[0];
    const parsed = parsePAWorkbook(readFile(file), { fileName: file });
    expect(parsed.errors).toEqual([]);
    const styles = new Set(parsed.records.map(r => r.style));
    expect(styles.size).toBeGreaterThan(0);
    for (const s of styles) expect(s).toMatch(/^100\d/);
  });

  it("TDLR BOYS sample uses toddler sizes (12M..5T)", () => {
    const file = "TDLR EPIC BOYS Q1 Flows from Q4 ROF PA.xls";
    const parsed = parsePAWorkbook(readFile(file), { fileName: file });
    const sizes = new Set(parsed.records.map(r => r.size));
    expect(sizes.has("12M")).toBe(true);
    expect(sizes.has("5T")).toBe(true);
  });

  it("KID EPIC BOYS sample uses only HAF channel", () => {
    const file = "KID EPIC BOYS Q1 Flows from Q4 ROF PA.xls";
    const parsed = parsePAWorkbook(readFile(file), { fileName: file });
    const channels = new Set(parsed.records.map(r => r.channel));
    expect(channels).toEqual(new Set(["HAF"]));
  });
});
