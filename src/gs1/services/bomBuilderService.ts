// ── BOM Builder Service — pure functions ───────────────────────────────────────
// All DB I/O lives in supabaseGs1.ts. This file is pure logic only.

import type { ScaleSizeRatio, UpcItem, BomStatus } from "../types";

// ── Domain types ──────────────────────────────────────────────────────────────

export interface BomLine {
  pack_gtin: string;
  child_upc: string;
  size: string;
  qty_in_pack: number;
}

export interface BomIssueInput {
  pack_gtin: string;
  issue_type: string;
  severity: "info" | "warning" | "error";
  message: string;
  context?: Record<string, unknown>;
}

export interface BomBuildResult {
  pack_gtin: string;
  lines: BomLine[];
  issues: BomIssueInput[];
  units_per_pack: number;
  status: BomStatus;
}

export interface BomCoverageSizeRow {
  size: string;
  qty_in_scale: number;
  upc: string | null;
  found: boolean;
}

export interface BomCheckResult {
  scale_code: string;
  sizes: BomCoverageSizeRow[];
  missing_sizes: string[];
  complete: boolean;
}

// ── buildBomLines ─────────────────────────────────────────────────────────────
// Build BOM for one pack GTIN using in-memory scale ratios + UPC items.
// Zero-qty ratio rows are skipped.
// Returns lines (to insert into pack_gtin_bom) and issues (to insert into
// pack_gtin_bom_issues), plus status and units_per_pack.

export function buildBomLines(
  packGtin: string,
  styleNo: string,
  color: string,
  scaleRatios: ScaleSizeRatio[],
  upcItems: UpcItem[]
): BomBuildResult {
  const lines: BomLine[] = [];
  const issues: BomIssueInput[] = [];

  const activeRatios = scaleRatios.filter(r => r.qty > 0);

  if (activeRatios.length === 0) {
    issues.push({
      pack_gtin: packGtin,
      issue_type: "missing_scale_ratio",
      severity: "error",
      message: `No scale ratios with qty > 0 found for pack GTIN ${packGtin} (${styleNo} / ${color})`,
    });
    return { pack_gtin: packGtin, lines, issues, units_per_pack: 0, status: "error" };
  }

  // Build lookup: "style|color|size" → UpcItem[]
  const upcMap = new Map<string, UpcItem[]>();
  for (const u of upcItems) {
    const key = `${u.style_no}|${u.color}|${u.size}`;
    const bucket = upcMap.get(key);
    if (bucket) bucket.push(u);
    else upcMap.set(key, [u]);
  }

  // Track UPCs already placed to detect cross-size duplicates
  const placedUpcs = new Map<string, string>(); // upc → size

  for (const ratio of activeRatios) {
    const key = `${styleNo}|${color}|${ratio.size}`;
    const matches = upcMap.get(key) ?? [];

    if (matches.length === 0) {
      issues.push({
        pack_gtin: packGtin,
        issue_type: "missing_upc_for_size",
        severity: "error",
        message: `No UPC found for ${styleNo} / ${color} / size ${ratio.size}`,
        context: { style_no: styleNo, color, size: ratio.size, qty_in_pack: ratio.qty },
      });
      continue;
    }

    if (matches.length > 1) {
      issues.push({
        pack_gtin: packGtin,
        issue_type: "duplicate_upc_match",
        severity: "warning",
        message: `${matches.length} UPCs match ${styleNo} / ${color} / size ${ratio.size} — using first`,
        context: { style_no: styleNo, color, size: ratio.size, upcs: matches.map(m => m.upc) },
      });
    }

    const upc = matches[0].upc;
    const prevSize = placedUpcs.get(upc);
    if (prevSize !== undefined) {
      issues.push({
        pack_gtin: packGtin,
        issue_type: "duplicate_upc_match",
        severity: "warning",
        message: `UPC ${upc} already matched size ${prevSize}, also matches size ${ratio.size}`,
        context: { upc, size1: prevSize, size2: ratio.size },
      });
    } else {
      placedUpcs.set(upc, ratio.size);
    }

    lines.push({ pack_gtin: packGtin, child_upc: upc, size: ratio.size, qty_in_pack: ratio.qty });
  }

  const units_per_pack = lines.reduce((s, l) => s + l.qty_in_pack, 0);
  const status = determineBomStatus(lines, issues);
  return { pack_gtin: packGtin, lines, issues, units_per_pack, status };
}

// ── determineBomStatus ────────────────────────────────────────────────────────

export function determineBomStatus(lines: BomLine[], issues: BomIssueInput[]): BomStatus {
  if (lines.length === 0) return "error";
  const hasErrors = issues.some(i => i.severity === "error");
  return hasErrors ? "incomplete" : "complete";
}

// ── checkUpcCoverage ──────────────────────────────────────────────────────────
// Cross-check: for a given style/color/scale, which sizes are missing a UPC?
// Zero-qty ratio rows are excluded from coverage requirements.

export function checkUpcCoverage(
  styleNo: string,
  color: string,
  scaleCode: string,
  scaleRatios: ScaleSizeRatio[],
  upcItems: UpcItem[]
): BomCheckResult {
  // Build per-size UPC lookup filtered to this style/color
  const upcBySize = new Map<string, string>();
  for (const u of upcItems) {
    if (u.style_no === styleNo && u.color === color) {
      upcBySize.set(u.size, u.upc);
    }
  }

  const sizes: BomCoverageSizeRow[] = scaleRatios
    .filter(r => r.qty > 0)
    .map(r => {
      const upc = upcBySize.get(r.size) ?? null;
      return { size: r.size, qty_in_scale: r.qty, upc, found: upc !== null };
    });

  const missing_sizes = sizes.filter(s => !s.found).map(s => s.size);
  return { scale_code: scaleCode, sizes, missing_sizes, complete: missing_sizes.length === 0 };
}
