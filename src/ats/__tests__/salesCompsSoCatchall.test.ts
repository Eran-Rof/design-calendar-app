// Tests for the SO-section catch-all row in the Sales Comps modal.
// The catch-all aggregates LY ship $ for styles that have NO open TY
// SO in the current scope, so the SO TOTAL LY reconciles with the
// Customer / Style / Sub-Cat TOTALs (which already include those
// styles via the per-style ship-history match).
import { describe, expect, it } from "vitest";
import {
  computeSoCatchallRow,
  SO_CATCHALL_KEY,
  SO_CATCHALL_LABEL,
  type SoRow,
} from "../salesCompsExport";

type Agg = { qty: number; rev: number; mrgn: number };

function lyMap(entries: Array<[string, Agg]>): Map<string, Agg> {
  return new Map(entries);
}

// Replicates the TOTAL math in SoCompsTable + pushSoSection: sum LY
// across data rows (deduped by style) and add the catch-all LY in
// explicitly. Used to assert reconciliation across groupBy variants.
function totalLyForSection(rows: SoRow[]): { qty: number; rev: number } {
  const dataRows = rows.filter((r): r is Extract<SoRow, { kind: "row" }> => r.kind === "row");
  const catchall = rows.find((r): r is Extract<SoRow, { kind: "subtotal" }> =>
    r.kind === "subtotal" && r.key === SO_CATCHALL_KEY);
  const seen = new Set<string>();
  let qty = 0, rev = 0;
  for (const r of dataRows) {
    const sk = r.style ?? r.key;
    if (!seen.has(sk)) {
      qty += r.lyQty;
      rev += r.lyRev;
      seen.add(sk);
    }
  }
  if (catchall) {
    qty += catchall.lyQty;
    rev += catchall.lyRev;
  }
  return { qty, rev };
}

describe("computeSoCatchallRow", () => {
  it("returns null when every LY style is covered by a TY SO", () => {
    const ly = lyMap([
      ["RYB0412",  { qty: 48345, rev: 328065, mrgn: 100000 }],
      ["RYB0412B", { qty: 6242,  rev: 34392,  mrgn: 12000  }],
    ]);
    const tyStyles = new Set(["RYB0412", "RYB0412B"]);
    expect(computeSoCatchallRow(tyStyles, ly)).toBeNull();
  });

  it("returns null when LY map is empty", () => {
    expect(computeSoCatchallRow(new Set<string>(), new Map())).toBeNull();
  });

  it("emits a single subtotal row for styles missing from the TY SO set", () => {
    const ly = lyMap([
      ["RYB0412",  { qty: 48345, rev: 328065, mrgn: 100000 }],
      ["RYB0412B", { qty: 6242,  rev: 34392,  mrgn: 12000  }],
    ]);
    const tyStyles = new Set(["RYB0412"]); // RYB0412B has LY but no TY SO
    const row = computeSoCatchallRow(tyStyles, ly);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("subtotal");
    expect(row!.key).toBe(SO_CATCHALL_KEY);
    expect(row!.label).toBe(SO_CATCHALL_LABEL);
    expect(row!.tyQty).toBe(0);
    expect(row!.tyRev).toBe(0);
    expect(row!.tyMrgn).toBe(0);
    expect(row!.lyQty).toBe(6242);
    expect(row!.lyRev).toBe(34392);
    expect(row!.lyMrgn).toBe(12000);
  });

  it("aggregates multiple missing styles into one row", () => {
    const ly = lyMap([
      ["A", { qty: 100, rev: 1000, mrgn: 250 }],
      ["B", { qty: 50,  rev: 500,  mrgn: 125 }],
      ["C", { qty: 200, rev: 2000, mrgn: 500 }], // covered by TY
    ]);
    const tyStyles = new Set(["C"]);
    const row = computeSoCatchallRow(tyStyles, ly);
    expect(row).not.toBeNull();
    expect(row!.lyQty).toBe(150);
    expect(row!.lyRev).toBe(1500);
    expect(row!.lyMrgn).toBe(375);
  });

  it("skips styles with zero/negative qty AND zero/negative rev", () => {
    const ly = lyMap([
      ["A", { qty: 0,  rev: 0,    mrgn: 0  }], // skipped
      ["B", { qty: 10, rev: 100,  mrgn: 25 }],
    ]);
    const row = computeSoCatchallRow(new Set<string>(), ly);
    expect(row).not.toBeNull();
    expect(row!.lyQty).toBe(10);
    expect(row!.lyRev).toBe(100);
  });

  it("includes styles with rev > 0 even when qty = 0 (price-only LY)", () => {
    const ly = lyMap([
      ["A", { qty: 0, rev: 500, mrgn: 100 }],
    ]);
    const row = computeSoCatchallRow(new Set<string>(), ly);
    expect(row).not.toBeNull();
    expect(row!.lyQty).toBe(0);
    expect(row!.lyRev).toBe(500);
  });

  it("operator's CSV worked example: SO TOTAL LY reconciles after fix", () => {
    // From the operator's CSV today:
    //   SO TOTAL LY = 48,345 / $328,065 (RYB0412 only — has a TY SO)
    //   Missing:     RYB0412B has 6,242 / $34,392 LY ship with no TY SO
    // After fix: SO TOTAL LY = 54,587 / $362,457 (matches other dim TOTALs)
    const ly = lyMap([
      ["RYB0412",  { qty: 48345, rev: 328065, mrgn: 0 }],
      ["RYB0412B", { qty: 6242,  rev: 34392,  mrgn: 0 }],
    ]);
    const tyStyles = new Set(["RYB0412"]);

    let totalLyQty = 0, totalLyRev = 0;
    for (const style of tyStyles) {
      const ent = ly.get(style);
      if (ent) { totalLyQty += ent.qty; totalLyRev += ent.rev; }
    }
    const catchall = computeSoCatchallRow(tyStyles, ly);
    if (catchall) {
      totalLyQty += catchall.lyQty;
      totalLyRev += catchall.lyRev;
    }
    expect(totalLyQty).toBe(54587);
    expect(totalLyRev).toBe(362457);

    expect(catchall!.lyQty).toBe(6242);
    expect(catchall!.lyRev).toBe(34392);
  });
});

describe("totalLyForSection — reconciliation across groupBy variants", () => {
  // The LY ship totals across the four "data" groupBy variants
  // (style, so, customer, category/sub_category) should all reconcile
  // to the SAME number once the catch-all is appended. This mirrors
  // the SoCompsTable / pushSoSection TOTAL math.
  const ly = lyMap([
    ["RYB0412",  { qty: 48345, rev: 328065, mrgn: 0 }],
    ["RYB0412B", { qty: 6242,  rev: 34392,  mrgn: 0 }],
  ]);
  const tyStyles = new Set(["RYB0412"]);
  const catchall = computeSoCatchallRow(tyStyles, ly)!;
  const expectedLyQty = 54587;
  const expectedLyRev = 362457;

  it("groupBy=so: per-order rows with one style each + catch-all", () => {
    const lyEnt = ly.get("RYB0412")!;
    const rows: SoRow[] = [
      { kind: "row", key: "SO-1", label: "SO-1",
        style: "RYB0412", orderNumber: "SO-1", customer: "Cust",
        cancelDate: "2026-06-01",
        tyQty: 100, tyRev: 1000, tyMrgn: 0,
        lyQty: lyEnt.qty, lyRev: lyEnt.rev, lyMrgn: 0 },
      catchall,
    ];
    expect(totalLyForSection(rows)).toEqual({ qty: expectedLyQty, rev: expectedLyRev });
  });

  it("groupBy=style: per-(style,SO) rows + per-style subtotal + catch-all", () => {
    const lyEnt = ly.get("RYB0412")!;
    const rows: SoRow[] = [
      { kind: "row", key: "RYB0412::SO-1", label: "RYB0412 — SO-1",
        style: "RYB0412", orderNumber: "SO-1", customer: "Cust",
        cancelDate: "2026-06-01",
        tyQty: 60, tyRev: 600, tyMrgn: 0,
        lyQty: lyEnt.qty, lyRev: lyEnt.rev, lyMrgn: 0 },
      { kind: "row", key: "RYB0412::SO-2", label: "RYB0412 — SO-2",
        style: "RYB0412", orderNumber: "SO-2", customer: "Cust",
        cancelDate: "2026-06-15",
        tyQty: 40, tyRev: 400, tyMrgn: 0,
        lyQty: lyEnt.qty, lyRev: lyEnt.rev, lyMrgn: 0 },
      // Per-style subtotal (not counted by TOTAL — dataRows-only).
      { kind: "subtotal", key: "__subtotal::RYB0412", label: "Subtotal — RYB0412",
        tyQty: 100, tyRev: 1000, tyMrgn: 0,
        lyQty: lyEnt.qty, lyRev: lyEnt.rev, lyMrgn: 0 },
      catchall,
    ];
    // LY dedup by style → only one RYB0412 LY contribution + catch-all.
    expect(totalLyForSection(rows)).toEqual({ qty: expectedLyQty, rev: expectedLyRev });
  });

  it("groupBy=customer: one aggregated row + catch-all", () => {
    const lyEnt = ly.get("RYB0412")!;
    const rows: SoRow[] = [
      { kind: "row", key: "ACME", label: "ACME",
        tyQty: 100, tyRev: 1000, tyMrgn: 0,
        lyQty: lyEnt.qty, lyRev: lyEnt.rev, lyMrgn: 0 },
      catchall,
    ];
    expect(totalLyForSection(rows)).toEqual({ qty: expectedLyQty, rev: expectedLyRev });
  });

  it("groupBy=sub_category: same shape, same reconciliation", () => {
    const lyEnt = ly.get("RYB0412")!;
    const rows: SoRow[] = [
      { kind: "row", key: "Tees", label: "Tees",
        tyQty: 100, tyRev: 1000, tyMrgn: 0,
        lyQty: lyEnt.qty, lyRev: lyEnt.rev, lyMrgn: 0 },
      catchall,
    ];
    expect(totalLyForSection(rows)).toEqual({ qty: expectedLyQty, rev: expectedLyRev });
  });

  it("no catch-all → TOTAL uses only the per-row LY contributions", () => {
    const lyEnt = ly.get("RYB0412")!;
    const rows: SoRow[] = [
      { kind: "row", key: "SO-1", label: "SO-1",
        style: "RYB0412", orderNumber: "SO-1", customer: "Cust",
        cancelDate: "2026-06-01",
        tyQty: 100, tyRev: 1000, tyMrgn: 0,
        lyQty: lyEnt.qty, lyRev: lyEnt.rev, lyMrgn: 0 },
    ];
    expect(totalLyForSection(rows)).toEqual({ qty: 48345, rev: 328065 });
  });
});
