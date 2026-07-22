// api/_lib/__tests__/arSizeEnrich.test.js
import { describe, it, expect } from "vitest";
import {
  parseMoneyCents, parseNum, parseCsv, parseInvoiceDetailCsv, usDateToIso,
  csvLineGroupKey, groupInvoiceCsvLines, aggregateGroupKey, distributeInt,
  verifyColorGroup, buildSizeLines, buildIshSizeRows,
  sizeKeyOf, alignSizeGrain, buildRelinkLines,
} from "../arSizeEnrich.js";

describe("parseMoneyCents", () => {
  it("parses quoted thousands and plain decimals to integer cents", () => {
    expect(parseMoneyCents("1,237.50")).toBe(123750);
    expect(parseMoneyCents("612.50")).toBe(61250);
    expect(parseMoneyCents("8.75")).toBe(875);
    expect(parseMoneyCents("30,870.00")).toBe(3087000);
  });
  it("tolerates BOM, $ and blanks", () => {
    expect(parseMoneyCents("﻿100.00")).toBe(10000);
    expect(parseMoneyCents("$50")).toBe(5000);
    expect(parseMoneyCents("")).toBe(0);
  });
  it("rounds half away from zero", () => {
    expect(parseMoneyCents("0.005")).toBe(1);
    expect(parseMoneyCents("1.014")).toBe(101);
  });
});

describe("parseNum", () => {
  it("parses quoted qty", () => {
    expect(parseNum("49.00")).toBe(49);
    expect(parseNum("1,528")).toBe(1528);
    expect(parseNum("")).toBeNaN();
  });
});

describe("parseCsv", () => {
  it("honours quoted fields containing commas", () => {
    const rows = parseCsv('a,b,c\n1,"2,3",4\n');
    expect(rows).toEqual([["a", "b", "c"], ["1", "2,3", "4"]]);
  });
  it("handles escaped double-quotes and CRLF and BOM", () => {
    const rows = parseCsv('﻿x,y\r\n"he said ""hi""",z\r\n');
    expect(rows[0]).toEqual(["x", "y"]);
    expect(rows[1]).toEqual(['he said "hi"', "z"]);
  });
  it("keeps a final row with no trailing newline", () => {
    const rows = parseCsv("p,q\n1,2");
    expect(rows.length).toBe(2);
    expect(rows[1]).toEqual(["1", "2"]);
  });
});

describe("parseInvoiceDetailCsv", () => {
  const csv =
    "﻿Txn Date,Item Number,Description,Sale Store,Qty,Amount,Invoice Number,Customer,Unit Price,Full Payment Date,Invoice Payment Status\n" +
    "01/01/2025,RYO0646-SHIITAKE/ OFF WHITE-S,DOUBLO Jkt,ROF Main,49.00,612.50,ROF-I142128,Ross,12.50,06/02/2025,Paid\n" +
    '01/01/2025,RYO0646-SHIITAKE/ OFF WHITE-M,DOUBLO Jkt,ROF Main,99.00,"1,237.50",ROF-I142128,Ross,12.50,06/02/2025,Paid\n';
  it("maps columns by header name", () => {
    const { header, lines } = parseInvoiceDetailCsv(csv);
    expect(header[0]).toBe("Txn Date");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({
      itemNumber: "RYO0646-SHIITAKE/ OFF WHITE-S",
      qty: 49, amountCents: 61250, invoiceNumber: "ROF-I142128", unitPriceCents: 1250,
    });
    expect(lines[1].amountCents).toBe(123750);
  });
});

describe("usDateToIso", () => {
  it("converts MM/DD/YYYY", () => {
    expect(usDateToIso("01/01/2025")).toBe("2025-01-01");
    expect(usDateToIso("12/3/2025")).toBe("2025-12-03");
    expect(usDateToIso("bad")).toBeNull();
  });
});

describe("group keys (style + colour + inseam)", () => {
  const styleByCode = new Map([
    ["RYB0594", "sid-594"], ["RYO0646", "sid-646"],
    ["PTYT0087", "sid-87"], ["PTYT0088", "sid-88"],
  ]);
  it("peels inseam from a jeans style token and keeps colour spelling-tolerant", () => {
    const a = csvLineGroupKey("RYB059430-Media Park- Drk Wash-30", styleByCode);
    expect(a.styleId).toBe("sid-594");
    expect(a.inseam).toBe("30");
    expect(a.colorKey).toBe("MEDIAPARKDARKWASH"); // Drk -> DARK
    const b = csvLineGroupKey("RYB059432-Media Park- Dark Wash-32", styleByCode);
    expect(b.inseam).toBe("32");
    expect(a.key).not.toBe(b.key); // different inseam -> different group
  });
  it("aggregateGroupKey matches a csv group key for the same style+colour+inseam", () => {
    const csv = csvLineGroupKey("RYB059430-Media Park- Drk Wash-30", styleByCode);
    const agg = aggregateGroupKey({ style_id: "sid-594", color: "Media Park- Dark Wash", inseam: "30" });
    expect(agg).toBe(csv.key);
  });
  it("same colourway on DIFFERENT styles keys apart (Psycho Tuna prebook)", () => {
    const a = csvLineGroupKey("PTYT0087-Moonless Nights-M", styleByCode);
    const b = csvLineGroupKey("PTYT0088-Moonless Nights-M", styleByCode);
    expect(a.colorKey).toBe(b.colorKey);
    expect(a.key).not.toBe(b.key); // style disambiguates
    expect(aggregateGroupKey({ style_id: "sid-87", color: "Moonless Nights", inseam: null })).toBe(a.key);
  });
  it("letter-size top has null inseam", () => {
    const g = csvLineGroupKey("RYO0646-SHIITAKE/ OFF WHITE-S", styleByCode);
    expect(g.inseam).toBeNull();
    expect(aggregateGroupKey({ style_id: "sid-646", color: "Shiitake/ Off White", inseam: null })).toBe(g.key);
  });
  it("groups multiple csv lines under one style+colour", () => {
    const lines = [
      { itemNumber: "RYO0646-SHIITAKE/ OFF WHITE-S", qty: 49, amountCents: 61250 },
      { itemNumber: "RYO0646-SHIITAKE/ OFF WHITE-M", qty: 99, amountCents: 123750 },
    ];
    const groups = groupInvoiceCsvLines(lines, styleByCode);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0].lines.length).toBe(2);
  });
});

describe("distributeInt (largest remainder)", () => {
  it("sums exactly to total and is proportional", () => {
    const parts = distributeInt(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });
  it("weights the split by qty", () => {
    const parts = distributeInt(1000, [478, 439, 846]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });
  it("handles all-zero weights by even spread", () => {
    const parts = distributeInt(7, [0, 0, 0]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(7);
  });
  it("handles a single line", () => {
    expect(distributeInt(2328480, [3528])).toEqual([2328480]);
  });
});

describe("verifyColorGroup", () => {
  const agg = { quantity: 297, line_total_cents: 371250, tax_amount_cents: 0 };
  it("passes on exact qty match and amount within tolerance", () => {
    const csv = [
      { qty: 49, amountCents: 61250 }, { qty: 99, amountCents: 123750 },
      { qty: 99, amountCents: 123750 }, { qty: 50, amountCents: 62500 },
    ];
    const r = verifyColorGroup(csv, agg, 5);
    expect(r.ok).toBe(true);
    expect(r.sumQty).toBe(297);
    expect(r.sumAmtCents).toBe(371250);
  });
  it("fails on qty mismatch regardless of amount", () => {
    const csv = [{ qty: 49, amountCents: 61250 }];
    const r = verifyColorGroup(csv, agg, 100000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/qty mismatch/);
  });
  it("fails when amount is outside tolerance", () => {
    const csv = [
      { qty: 148, amountCents: 200000 }, { qty: 149, amountCents: 180000 },
    ];
    const r = verifyColorGroup(csv, agg, 5);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/amount mismatch/);
  });
});

describe("buildSizeLines conserves the invoice total", () => {
  const agg = {
    quantity: 3528, unit_price_cents: 875, line_total_cents: 3087000,
    tax_amount_cents: 0, cogs_cents: 2328480, description: "Historical line",
    revenue_account_id: null, cogs_account_id: null, brand_id: "b1", channel_id: "c1", source: "manual",
  };
  const csv = [
    { qty: 478, amountCents: 418250, description: "Jean" },
    { qty: 439, amountCents: 384125, description: "Jean" },
    { qty: 846, amountCents: 740250, description: "Jean" },
    { qty: 431, amountCents: 377125, description: "Jean" },
    { qty: 902, amountCents: 789250, description: "Jean" },
    { qty: 432, amountCents: 378000, description: "Jean" },
  ];
  it("uses agg unit price so Σ(qty*unit) equals the aggregate total exactly", () => {
    const ids = csv.map((_, i) => `item-${i}`);
    const { lines, nextLineNumber } = buildSizeLines(csv, ids, agg, 1);
    expect(lines.length).toBe(6);
    expect(nextLineNumber).toBe(7);
    const sumTotal = lines.reduce((a, l) => a + l.quantity * l.unit_price_cents, 0);
    expect(sumTotal).toBe(3087000);
    lines.forEach((l) => expect(l.unit_price_cents).toBe(875));
    expect(lines[0].inventory_item_id).toBe("item-0");
  });
  it("distributes cogs so the sum is conserved", () => {
    const ids = csv.map((_, i) => `item-${i}`);
    const { lines } = buildSizeLines(csv, ids, agg, 1);
    const sumCogs = lines.reduce((a, l) => a + l.cogs_cents, 0);
    expect(sumCogs).toBe(2328480);
  });
});

describe("Case B: alignSizeGrain + buildRelinkLines", () => {
  // already-size-grain aggregate lines: one line per size, size-NULL SKU whose
  // sku_code embeds the size (PTBT0007-INDIGO-S/8 …), plus the CSV counterparts.
  const aggLines = [
    { quantity: 4, unit_price_cents: 1900, cogs_cents: 400, tax_amount_cents: 0, source: "manual", brand_id: "b", channel_id: "c", anchor: { sku_code: "PTBT0007-INDIGO-S/8" } },
    { quantity: 4, unit_price_cents: 1900, cogs_cents: 400, tax_amount_cents: 0, source: "manual", brand_id: "b", channel_id: "c", anchor: { sku_code: "PTBT0007-INDIGO-M/10" } },
    { quantity: 4, unit_price_cents: 1900, cogs_cents: 400, tax_amount_cents: 0, source: "manual", brand_id: "b", channel_id: "c", anchor: { sku_code: "PTBT0007-INDIGO-L/14" } },
    { quantity: 4, unit_price_cents: 1900, cogs_cents: 400, tax_amount_cents: 0, source: "manual", brand_id: "b", channel_id: "c", anchor: { sku_code: "PTBT0007-INDIGO-XL/18" } },
  ];
  const csvLines = [
    { parsed: { size: "S/8" }, description: "Youth Tee", qty: 4, amountCents: 5700 },
    { parsed: { size: "M/10" }, description: "Youth Tee", qty: 4, amountCents: 5700 },
    { parsed: { size: "L/14" }, description: "Youth Tee", qty: 4, amountCents: 5700 },
    { parsed: { size: "XL/18" }, description: "Youth Tee", qty: 4, amountCents: 5700 },
  ];
  it("pairs each aggregate line to its CSV size 1:1", () => {
    const r = alignSizeGrain(aggLines, csvLines);
    expect(r.ok).toBe(true);
    expect(r.pairs.length).toBe(4);
    expect(sizeKeyOf(r.pairs[0].agg.anchor.sku_code.split("-").pop())).toBe("S/8");
    expect(r.pairs[0].csv.parsed.size).toBe("S/8");
  });
  it("fails when counts differ", () => {
    expect(alignSizeGrain(aggLines.slice(0, 3), csvLines).ok).toBe(false);
  });
  it("relink lines carry aggregate qty/unit/cogs verbatim (header conserved)", () => {
    const r = alignSizeGrain(aggLines, csvLines);
    const withIds = r.pairs.map((p, i) => ({ ...p, itemId: `sized-${i}` }));
    const { lines, nextLineNumber } = buildRelinkLines(withIds, 1);
    expect(lines.length).toBe(4);
    expect(nextLineNumber).toBe(5);
    const sumTotal = lines.reduce((a, l) => a + l.quantity * l.unit_price_cents, 0);
    expect(sumTotal).toBe(4 * 4 * 1900); // == Σ aggregate line_total
    expect(lines[0].inventory_item_id).toBe("sized-0");
    expect(lines.reduce((a, l) => a + l.cogs_cents, 0)).toBe(1600);
  });
  it("folds letter sizes so 'S' aligns with 'SMALL'", () => {
    expect(sizeKeyOf("S")).toBe("SMALL");
    expect(sizeKeyOf("30")).toBe("30");
    expect(sizeKeyOf("S/8")).toBe("S/8");
  });
});

describe("buildIshSizeRows conserves qty and net/gross", () => {
  const colorRow = { qty: 297, gross_amount: 3712.5, net_amount: 3712.5, unit_price: 12.5 };
  const csv = [
    { qty: 49, amountCents: 61250 }, { qty: 99, amountCents: 123750 },
    { qty: 99, amountCents: 123750 }, { qty: 50, amountCents: 62500 },
  ];
  it("size rows sum to the colour row qty and net", () => {
    const meta = csv.map((_, i) => ({ skuId: `s${i}`, sourceLineKey: `k${i}` }));
    const rows = buildIshSizeRows(csv, meta, colorRow);
    expect(rows.length).toBe(4);
    const sq = rows.reduce((a, r) => a + r.qty, 0);
    const sn = rows.reduce((a, r) => a + r.net_amount, 0);
    expect(sq).toBeCloseTo(297, 6);
    expect(sn).toBeCloseTo(3712.5, 2);
  });
  it("null gross/net stays null", () => {
    const meta = csv.map((_, i) => ({ skuId: `s${i}`, sourceLineKey: `k${i}` }));
    const rows = buildIshSizeRows(csv, meta, { qty: 297, gross_amount: null, net_amount: null, unit_price: 12.5 });
    rows.forEach((r) => { expect(r.gross_amount).toBeNull(); expect(r.net_amount).toBeNull(); });
  });
});
