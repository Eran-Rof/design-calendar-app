import { describe, it, expect } from "vitest";
import {
  normalizeSsccInput,
  buildContentLines,
  explodeBom,
  aggregateExplosionLines,
  applyReceivedQtys,
  runExplosion,
  isAlreadyReceived,
  determineSessionStatus,
} from "../services/receivingService";
import type { Carton, CartonContent, PackGtinBom, UpcItem } from "../types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCarton(overrides: Partial<Carton> = {}): Carton {
  return {
    id: "carton-1",
    sscc: "003109270000000017",
    serial_reference: 1,
    batch_id: null,
    batch_line_id: null,
    upload_id: null,
    po_number: "PO-001",
    carton_no: "C001",
    pack_gtin: "10310927000012",
    style_no: "100227BK",
    color: "BLACK",
    scale_code: "CD",
    carton_seq: 1,
    total_packs: 1,
    total_units: 6,
    channel: "HAF",
    status: "generated",
    created_at: "2026-04-25T00:00:00Z",
    updated_at: "2026-04-25T00:00:00Z",
    ...overrides,
  } as Carton;
}

function makeContent(overrides: Partial<CartonContent> = {}): CartonContent {
  return {
    id: "cc-1",
    carton_id: "carton-1",
    pack_gtin: "10310927000012",
    style_no: "100227BK",
    color: "BLACK",
    scale_code: "CD",
    child_upc: null,
    size: null,
    qty_per_pack: 0,
    pack_qty: 2,
    exploded_unit_qty: 12,
    created_at: "2026-04-25T00:00:00Z",
    ...overrides,
  };
}

const BOM_CD: PackGtinBom[] = [
  { id: "b1", pack_gtin: "10310927000012", child_upc: "UPC-S", size: "S", qty_in_pack: 1, created_at: "" },
  { id: "b2", pack_gtin: "10310927000012", child_upc: "UPC-M", size: "M", qty_in_pack: 2, created_at: "" },
  { id: "b3", pack_gtin: "10310927000012", child_upc: "UPC-L", size: "L", qty_in_pack: 2, created_at: "" },
  { id: "b4", pack_gtin: "10310927000012", child_upc: "UPC-XL", size: "XL", qty_in_pack: 1, created_at: "" },
];

const UPC_MAP = new Map<string, UpcItem>([
  ["UPC-S",  { id: "u1", upc: "UPC-S",  style_no: "100227BK", color: "BLACK", size: "S",  description: null, source_method: "manual", created_at: "", updated_at: "" }],
  ["UPC-M",  { id: "u2", upc: "UPC-M",  style_no: "100227BK", color: "BLACK", size: "M",  description: null, source_method: "manual", created_at: "", updated_at: "" }],
  ["UPC-L",  { id: "u3", upc: "UPC-L",  style_no: "100227BK", color: "BLACK", size: "L",  description: null, source_method: "manual", created_at: "", updated_at: "" }],
  ["UPC-XL", { id: "u4", upc: "UPC-XL", style_no: "100227BK", color: "BLACK", size: "XL", description: null, source_method: "manual", created_at: "", updated_at: "" }],
]);

const BOM_MAP = new Map<string, PackGtinBom[]>([["10310927000012", BOM_CD]]);
const EMPTY_BOM_MAP = new Map<string, PackGtinBom[]>();
const EMPTY_UPC_MAP = new Map<string, UpcItem>();
const EMPTY_QTY_MAP = new Map<string, number>();

// ── normalizeSsccInput ────────────────────────────────────────────────────────

describe("normalizeSsccInput", () => {
  it("strips spaces and returns raw 18-digit SSCC unchanged", () => {
    expect(normalizeSsccInput("003109270000000017")).toBe("003109270000000017");
  });

  it("strips '(00) ' prefix from display format", () => {
    expect(normalizeSsccInput("(00) 003109270000000017")).toBe("003109270000000017");
  });

  it("strips internal spaces", () => {
    expect(normalizeSsccInput("0031 0927 0000 0000 17")).toBe("003109270000000017");
  });

  it("strips hyphens", () => {
    expect(normalizeSsccInput("0031-0927-0000-0000-17")).toBe("003109270000000017");
  });
});

// ── buildContentLines ─────────────────────────────────────────────────────────

describe("buildContentLines", () => {
  it("uses carton_contents rows when pack_qty is set", () => {
    const carton = makeCarton();
    const contents = [makeContent({ pack_gtin: "10310927000012", pack_qty: 3 })];
    const lines = buildContentLines(carton, contents);
    expect(lines).toHaveLength(1);
    expect(lines[0].pack_qty).toBe(3);
    expect(lines[0].pack_gtin).toBe("10310927000012");
  });

  it("ignores content rows where pack_qty is null or 0", () => {
    const carton = makeCarton({ pack_gtin: "10310927000012" });
    const contents = [makeContent({ pack_qty: null })];
    const lines = buildContentLines(carton, contents);
    // Falls back to carton.pack_gtin with pack_qty = 1
    expect(lines).toHaveLength(1);
    expect(lines[0].pack_qty).toBe(1);
  });

  it("falls back to carton.pack_gtin with pack_qty=1 when no contents", () => {
    const carton = makeCarton({ pack_gtin: "10310927000012" });
    const lines = buildContentLines(carton, []);
    expect(lines).toHaveLength(1);
    expect(lines[0].pack_gtin).toBe("10310927000012");
    expect(lines[0].pack_qty).toBe(1);
  });

  it("returns empty when carton has no pack_gtin and no contents", () => {
    const carton = makeCarton({ pack_gtin: null });
    const lines = buildContentLines(carton, []);
    expect(lines).toHaveLength(0);
  });

  it("handles multiple content lines (multiple GTINs per carton)", () => {
    const carton = makeCarton();
    const contents = [
      makeContent({ pack_gtin: "GTIN-A", pack_qty: 2 }),
      makeContent({ pack_gtin: "GTIN-B", pack_qty: 3 }),
    ];
    const lines = buildContentLines(carton, contents);
    expect(lines).toHaveLength(2);
    expect(lines.map(l => l.pack_gtin)).toEqual(["GTIN-A", "GTIN-B"]);
  });
});

// ── explodeBom ────────────────────────────────────────────────────────────────

describe("explodeBom", () => {
  it("explodes one content line to 4 UPC lines for a 4-size scale", () => {
    const carton = makeCarton();
    const contents = [makeContent({ pack_qty: 1 })];
    const lines = buildContentLines(carton, contents);
    const { lines: exploded, missingBomGtins } = explodeBom(lines, BOM_MAP, UPC_MAP);
    expect(exploded).toHaveLength(4);
    expect(missingBomGtins).toHaveLength(0);
  });

  it("calculates expected_qty = pack_qty × qty_in_pack", () => {
    const contents = [makeContent({ pack_qty: 3 })];
    const carton = makeCarton();
    const lines = buildContentLines(carton, contents);
    const { lines: exploded } = explodeBom(lines, BOM_MAP, UPC_MAP);
    const mLine = exploded.find(l => l.size === "M")!;
    expect(mLine.expected_qty).toBe(6); // 3 packs × 2 per pack
    const sLine = exploded.find(l => l.size === "S")!;
    expect(sLine.expected_qty).toBe(3); // 3 packs × 1 per pack
  });

  it("records missing BOM GTINs", () => {
    const carton = makeCarton({ pack_gtin: "UNKNOWN-GTIN" });
    const lines = buildContentLines(carton, []);
    const { lines: exploded, missingBomGtins } = explodeBom(lines, EMPTY_BOM_MAP, EMPTY_UPC_MAP);
    expect(exploded).toHaveLength(0);
    expect(missingBomGtins).toContain("UNKNOWN-GTIN");
  });

  it("handles partial BOM coverage — some GTINs have BOM, some don't", () => {
    const contents = [
      makeContent({ pack_gtin: "10310927000012", pack_qty: 1 }),
      makeContent({ pack_gtin: "NO-BOM-GTIN",    pack_qty: 1 }),
    ];
    const carton = makeCarton();
    const lines = buildContentLines(carton, contents);
    const { lines: exploded, missingBomGtins } = explodeBom(lines, BOM_MAP, UPC_MAP);
    expect(exploded).toHaveLength(4); // only the known GTIN exploded
    expect(missingBomGtins).toContain("NO-BOM-GTIN");
  });

  it("falls back to content style/color when UPC not in upcMap", () => {
    const contents = [makeContent({ pack_qty: 1, style_no: "STYLE-X", color: "RED" })];
    const carton = makeCarton({ style_no: "STYLE-X", color: "RED" });
    const lines = buildContentLines(carton, contents);
    const { lines: exploded } = explodeBom(lines, BOM_MAP, EMPTY_UPC_MAP);
    expect(exploded[0].style_no).toBe("STYLE-X");
    expect(exploded[0].color).toBe("RED");
  });
});

// ── aggregateExplosionLines ───────────────────────────────────────────────────

describe("aggregateExplosionLines", () => {
  it("keeps unique UPCs as separate lines", () => {
    const contents = [makeContent({ pack_qty: 1 })];
    const carton = makeCarton();
    const { lines } = explodeBom(buildContentLines(carton, contents), BOM_MAP, UPC_MAP);
    const agg = aggregateExplosionLines(lines);
    expect(agg).toHaveLength(4);
  });

  it("sums expected_qty when the same UPC appears from multiple content lines", () => {
    // Two content lines with the same GTIN (same BOM) → same UPCs double up
    const contents = [
      makeContent({ pack_gtin: "10310927000012", pack_qty: 1 }),
      makeContent({ pack_gtin: "10310927000012", pack_qty: 2 }),
    ];
    const carton = makeCarton();
    const { lines } = explodeBom(buildContentLines(carton, contents), BOM_MAP, UPC_MAP);
    const agg = aggregateExplosionLines(lines);
    expect(agg).toHaveLength(4); // still 4 sizes
    const mLine = agg.find(l => l.size === "M")!;
    expect(mLine.expected_qty).toBe(6); // (1+2) packs × 2 qty_in_pack
  });

  it("sets initial received_qty equal to expected_qty", () => {
    const contents = [makeContent({ pack_qty: 2 })];
    const carton = makeCarton();
    const { lines } = explodeBom(buildContentLines(carton, contents), BOM_MAP, UPC_MAP);
    const agg = aggregateExplosionLines(lines);
    for (const line of agg) {
      expect(line.received_qty).toBe(line.expected_qty);
    }
  });

  it("sets initial variance_qty = 0 and line_status = expected", () => {
    const contents = [makeContent({ pack_qty: 1 })];
    const carton = makeCarton();
    const { lines } = explodeBom(buildContentLines(carton, contents), BOM_MAP, UPC_MAP);
    const agg = aggregateExplosionLines(lines);
    for (const line of agg) {
      expect(line.variance_qty).toBe(0);
      expect(line.line_status).toBe("expected");
    }
  });

  it("records which pack GTINs contributed to each aggregated line", () => {
    const contents = [makeContent({ pack_qty: 1 })];
    const carton = makeCarton();
    const { lines } = explodeBom(buildContentLines(carton, contents), BOM_MAP, UPC_MAP);
    const agg = aggregateExplosionLines(lines);
    expect(agg[0].source_pack_gtins).toContain("10310927000012");
  });

  it("returns empty array when no explosion lines", () => {
    expect(aggregateExplosionLines([])).toHaveLength(0);
  });
});

// ── applyReceivedQtys ─────────────────────────────────────────────────────────

describe("applyReceivedQtys", () => {
  function getBaseAgg() {
    const contents = [makeContent({ pack_qty: 1 })];
    const carton = makeCarton();
    const { lines } = explodeBom(buildContentLines(carton, contents), BOM_MAP, UPC_MAP);
    return aggregateExplosionLines(lines);
  }

  it("exact match → variance_qty = 0, line_status = matched", () => {
    const agg = getBaseAgg();
    const qtys = new Map(agg.map(l => [l.child_upc, l.expected_qty]));
    const result = applyReceivedQtys(agg, qtys);
    for (const line of result) {
      expect(line.variance_qty).toBe(0);
      expect(line.line_status).toBe("matched");
    }
  });

  it("short receive → variance_qty negative, line_status = variance", () => {
    const agg = getBaseAgg();
    const mLine = agg.find(l => l.size === "M")!;
    const qtys = new Map([[mLine.child_upc, mLine.expected_qty - 1]]);
    const result = applyReceivedQtys(agg, qtys);
    const updated = result.find(l => l.child_upc === mLine.child_upc)!;
    expect(updated.variance_qty).toBe(-1);
    expect(updated.line_status).toBe("variance");
  });

  it("over receive → variance_qty positive, line_status = variance", () => {
    const agg = getBaseAgg();
    const sLine = agg.find(l => l.size === "S")!;
    const qtys = new Map([[sLine.child_upc, sLine.expected_qty + 2]]);
    const result = applyReceivedQtys(agg, qtys);
    const updated = result.find(l => l.child_upc === sLine.child_upc)!;
    expect(updated.variance_qty).toBe(2);
    expect(updated.line_status).toBe("variance");
  });

  it("does not mutate the original aggregated array", () => {
    const agg = getBaseAgg();
    const original = agg.map(l => ({ ...l }));
    applyReceivedQtys(agg, new Map([["UPC-S", 0]]));
    expect(agg[0].received_qty).toBe(original[0].received_qty);
  });

  it("uses default received_qty when upc not in qtys map", () => {
    const agg = getBaseAgg();
    const result = applyReceivedQtys(agg, EMPTY_QTY_MAP);
    for (const line of result) {
      expect(line.received_qty).toBe(line.expected_qty);
    }
  });
});

// ── runExplosion (integration) ────────────────────────────────────────────────

describe("runExplosion", () => {
  it("returns totalExpected = sum of all expected_qty", () => {
    const carton = makeCarton();
    const contents = [makeContent({ pack_qty: 2 })];
    // Scale CD: S=1, M=2, L=2, XL=1 → total = 6 per pack → 2 packs = 12
    const result = runExplosion(carton, contents, BOM_MAP, UPC_MAP, EMPTY_QTY_MAP);
    expect(result.totalExpected).toBe(12);
  });

  it("returns totalReceived = sum of received_qty (defaults to expected)", () => {
    const carton = makeCarton();
    const contents = [makeContent({ pack_qty: 1 })];
    const result = runExplosion(carton, contents, BOM_MAP, UPC_MAP, EMPTY_QTY_MAP);
    expect(result.totalReceived).toBe(result.totalExpected);
  });

  it("applies edited qtys correctly", () => {
    const carton = makeCarton();
    const contents = [makeContent({ pack_qty: 1 })];
    const edited = new Map([["UPC-S", 0]]); // receive 0 instead of expected 1
    const result = runExplosion(carton, contents, BOM_MAP, UPC_MAP, edited);
    const sLine = result.aggregated.find(l => l.child_upc === "UPC-S")!;
    expect(sLine.received_qty).toBe(0);
    expect(sLine.variance_qty).toBe(-1);
    expect(result.totalReceived).toBe(result.totalExpected - 1);
  });

  it("missing BOM propagates to missingBomGtins", () => {
    const carton = makeCarton({ pack_gtin: "UNKNOWN" });
    const result = runExplosion(carton, [], EMPTY_BOM_MAP, EMPTY_UPC_MAP, EMPTY_QTY_MAP);
    expect(result.missingBomGtins).toContain("UNKNOWN");
    expect(result.aggregated).toHaveLength(0);
    expect(result.totalExpected).toBe(0);
  });
});

// ── isAlreadyReceived ─────────────────────────────────────────────────────────

describe("isAlreadyReceived", () => {
  it("returns true when carton status is received", () => {
    expect(isAlreadyReceived(makeCarton({ status: "received" }))).toBe(true);
  });

  it("returns false when carton status is generated", () => {
    expect(isAlreadyReceived(makeCarton({ status: "generated" }))).toBe(false);
  });

  it("returns false when carton status is shipped", () => {
    expect(isAlreadyReceived(makeCarton({ status: "shipped" }))).toBe(false);
  });

  it("returns false when carton status is cancelled", () => {
    expect(isAlreadyReceived(makeCarton({ status: "cancelled" }))).toBe(false);
  });
});

// ── determineSessionStatus ────────────────────────────────────────────────────

describe("determineSessionStatus", () => {
  it("returns received when all lines have variance_qty = 0", () => {
    const contents = [makeContent({ pack_qty: 1 })];
    const carton = makeCarton();
    const { lines } = explodeBom(buildContentLines(carton, contents), BOM_MAP, UPC_MAP);
    const agg = applyReceivedQtys(aggregateExplosionLines(lines), EMPTY_QTY_MAP);
    expect(determineSessionStatus(agg)).toBe("received");
  });

  it("returns variance when any line has non-zero variance_qty", () => {
    const contents = [makeContent({ pack_qty: 1 })];
    const carton = makeCarton();
    const { lines } = explodeBom(buildContentLines(carton, contents), BOM_MAP, UPC_MAP);
    const agg = applyReceivedQtys(
      aggregateExplosionLines(lines),
      new Map([["UPC-S", 0]])
    );
    expect(determineSessionStatus(agg)).toBe("variance");
  });

  it("returns received for an empty aggregated list", () => {
    expect(determineSessionStatus([])).toBe("received");
  });
});
