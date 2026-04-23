// ── Receiving service — pure functions ────────────────────────────────────────
// All DB I/O lives in supabaseGs1.ts. This file is pure logic only.
// That keeps tests fast (no network) and the logic clearly separated.

import type { Carton, CartonContent, PackGtinBom, UpcItem } from "../types";

// ── Domain types ──────────────────────────────────────────────────────────────

/** What we know is inside the carton — derived from carton_contents or the carton row itself. */
export interface ReceivingContentLine {
  pack_gtin: string;
  style_no: string;
  color: string;
  scale_code: string;
  pack_qty: number; // how many packs of this GTIN are in the carton
}

/** One exploded row — one child UPC from one content line. */
export interface ExplosionLine {
  child_upc: string;
  style_no: string;
  color: string;
  size: string;
  pack_gtin: string;
  scale_code: string;
  pack_qty: number;
  qty_in_pack: number;
  expected_qty: number; // = pack_qty × qty_in_pack
}

/** Aggregated across multiple content lines — what the user edits for receiving. */
export interface AggregatedLine {
  child_upc: string;
  style_no: string;
  color: string;
  size: string;
  expected_qty: number;
  received_qty: number;
  variance_qty: number;
  line_status: "matched" | "variance" | "expected";
  source_pack_gtins: string[];
}

export interface ExplosionResult {
  contentLines: ReceivingContentLine[];
  explosionLines: ExplosionLine[];
  aggregated: AggregatedLine[];
  missingBomGtins: string[];
  totalExpected: number;
  totalReceived: number;
}

// ── Normalize SSCC input ──────────────────────────────────────────────────────
// Accept "003109270000000017" or "(00) 003109270000000017"

export function normalizeSsccInput(raw: string): string {
  const stripped = raw.replace(/[\s\-()]/g, "");
  // If prefixed with AI "00", strip it and return remaining 18 digits
  if (stripped.startsWith("00") && stripped.length === 20) {
    return stripped.slice(2);
  }
  return stripped;
}

// ── Build content lines ───────────────────────────────────────────────────────
// If carton_contents rows exist, use them.
// If not but carton has a pack_gtin, synthesise one content line (pack_qty=1).
// If neither, return empty (BOM explosion is impossible).

export function buildContentLines(
  carton: Carton,
  contents: CartonContent[]
): ReceivingContentLine[] {
  // Use DB content rows if available and have pack_qty set
  const withQty = contents.filter(c => c.pack_gtin && (c.pack_qty ?? 0) > 0);
  if (withQty.length > 0) {
    return withQty.map(c => ({
      pack_gtin:  c.pack_gtin,
      style_no:   c.style_no  ?? carton.style_no  ?? "",
      color:      c.color     ?? carton.color      ?? "",
      scale_code: c.scale_code ?? carton.scale_code ?? "",
      pack_qty:   c.pack_qty!,
    }));
  }

  // Fallback: carton row has pack_gtin → one pack per carton
  if (carton.pack_gtin) {
    return [{
      pack_gtin:  carton.pack_gtin,
      style_no:   carton.style_no  ?? "",
      color:      carton.color     ?? "",
      scale_code: carton.scale_code ?? "",
      pack_qty:   1,
    }];
  }

  return [];
}

// ── BOM explosion ─────────────────────────────────────────────────────────────
// For each content line, look up BOM records (keyed by pack_gtin).
// expected_qty = pack_qty × qty_in_pack.
// If no BOM rows exist for a GTIN, add it to missingBomGtins.
// upcMap provides display info (style/color/size) keyed by UPC code.

export function explodeBom(
  contentLines: ReceivingContentLine[],
  bomMap: Map<string, PackGtinBom[]>,
  upcMap: Map<string, UpcItem>
): { lines: ExplosionLine[]; missingBomGtins: string[] } {
  const lines: ExplosionLine[] = [];
  const missingBomGtins: string[] = [];

  for (const content of contentLines) {
    const bomRows = bomMap.get(content.pack_gtin) ?? [];
    if (bomRows.length === 0) {
      missingBomGtins.push(content.pack_gtin);
      continue;
    }
    for (const bom of bomRows) {
      const upcInfo = upcMap.get(bom.child_upc);
      lines.push({
        child_upc:    bom.child_upc,
        style_no:     upcInfo?.style_no ?? content.style_no,
        color:        upcInfo?.color    ?? content.color,
        size:         bom.size,
        pack_gtin:    content.pack_gtin,
        scale_code:   content.scale_code,
        pack_qty:     content.pack_qty,
        qty_in_pack:  bom.qty_in_pack,
        expected_qty: content.pack_qty * bom.qty_in_pack,
      });
    }
  }

  return { lines, missingBomGtins };
}

// ── Aggregate by UPC ──────────────────────────────────────────────────────────
// If the same child_upc appears across multiple content lines, sum expected_qty.
// Initial received_qty = expected_qty (user can adjust before confirming).

export function aggregateExplosionLines(lines: ExplosionLine[]): AggregatedLine[] {
  const map = new Map<string, AggregatedLine>();

  for (const line of lines) {
    const existing = map.get(line.child_upc);
    if (existing) {
      existing.expected_qty += line.expected_qty;
      existing.received_qty += line.expected_qty;
      if (!existing.source_pack_gtins.includes(line.pack_gtin)) {
        existing.source_pack_gtins.push(line.pack_gtin);
      }
    } else {
      map.set(line.child_upc, {
        child_upc:        line.child_upc,
        style_no:         line.style_no,
        color:            line.color,
        size:             line.size,
        expected_qty:     line.expected_qty,
        received_qty:     line.expected_qty, // default = expected
        variance_qty:     0,
        line_status:      "expected",
        source_pack_gtins: [line.pack_gtin],
      });
    }
  }

  // Sort: style → color → size
  return Array.from(map.values()).sort((a, b) =>
    a.style_no.localeCompare(b.style_no) ||
    a.color.localeCompare(b.color) ||
    a.size.localeCompare(b.size)
  );
}

// ── Apply user-edited received quantities ─────────────────────────────────────
// receivedQtys: Map<child_upc, received_qty>
// Returns new array — does not mutate the input.

export function applyReceivedQtys(
  aggregated: AggregatedLine[],
  receivedQtys: Map<string, number>
): AggregatedLine[] {
  return aggregated.map(line => {
    const received = receivedQtys.has(line.child_upc)
      ? receivedQtys.get(line.child_upc)!
      : line.received_qty;
    const variance = received - line.expected_qty;
    return {
      ...line,
      received_qty:  received,
      variance_qty:  variance,
      line_status:   variance === 0 ? "matched" : "variance",
    };
  });
}

// ── Full explosion pipeline ───────────────────────────────────────────────────
// Convenience wrapper that runs all three steps and returns the full result.

export function runExplosion(
  carton: Carton,
  contents: CartonContent[],
  bomMap: Map<string, PackGtinBom[]>,
  upcMap: Map<string, UpcItem>,
  editedQtys: Map<string, number>
): ExplosionResult {
  const contentLines = buildContentLines(carton, contents);
  const { lines: explosionLines, missingBomGtins } = explodeBom(contentLines, bomMap, upcMap);
  const rawAggregated = aggregateExplosionLines(explosionLines);
  const aggregated = applyReceivedQtys(rawAggregated, editedQtys);
  const totalExpected = aggregated.reduce((s, l) => s + l.expected_qty, 0);
  const totalReceived = aggregated.reduce((s, l) => s + l.received_qty, 0);
  return { contentLines, explosionLines, aggregated, missingBomGtins, totalExpected, totalReceived };
}

// ── Duplicate receiving protection ────────────────────────────────────────────

export function isAlreadyReceived(carton: Carton): boolean {
  return carton.status === "received";
}

// ── Session status determination ──────────────────────────────────────────────
// Called after user edits to determine final session status.

export function determineSessionStatus(
  aggregated: AggregatedLine[]
): "received" | "variance" {
  return aggregated.every(l => l.variance_qty === 0) ? "received" : "variance";
}
