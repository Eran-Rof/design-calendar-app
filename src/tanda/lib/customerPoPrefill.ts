// src/tanda/lib/customerPoPrefill.ts
//
// Turns the AI-parsed customer PO (from /api/internal/sales-orders/parse-
// customer-po) into a LineMatrixBody seed + a list of "double-check" warnings.
//
// Rules (operator-confirmed 2026-06-13):
//  - Use the PO's EXACT per-size quantities when given; flag any size that isn't
//    a full carton of 24 (the operator can round each up).
//  - When only a total is given, distribute across sizes via the style's Style
//    Master size scale (rounding each size up to a full carton — distributeByPack).
//  - PPK styles: cartons = ceil(total ÷ units-per-carton); flag the rounding.
//  - If a style code matches BOTH a base and a PPK style, it's ambiguous — the
//    caller must ask the operator which to use before building the seed.

import type { SeedSection } from "../LineMatrixBody";
import { distributeByPack, hasUsablePack, isPartialCarton, type SizePack } from "../../shared/sizeScale";

export type ParsedPoLine = {
  style_code: string | null;
  color: string | null;
  description: string | null;
  unit_price: number | null;
  total_qty: number | null;
  size_breakdown: { size: string; qty: number }[] | null;
};
export type ParsedPo = {
  customer_name: string | null;
  customer_po_number: string | null;
  payment_terms: string | null;
  start_ship_date: string | null;
  cancel_date: string | null;
  currency: string;
  lines: ParsedPoLine[];
};

export type StyleLite = {
  id: string;
  style_code: string;
  style_name?: string | null;
  attributes?: { size_scale_pack?: Record<string, number> } | null;
};

export type PrefillWarning = { style: string; detail: string };

// ── PPK helpers (client mirrors of api/_lib/prepack.js) ──────────────────────
export function extractPpk(v?: string | null): number | null {
  if (!v) return null;
  const m = String(v).match(/PPK[\s_-]*(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function isPpkStyle(code?: string | null): boolean {
  return !!code && /PPK/i.test(code);
}
export function baseStyleCode(code?: string | null): string {
  return code ? code.replace(/[-_\s]*PPK\d*$/i, "").trim() : (code || "");
}

// ── Line → style resolution ──────────────────────────────────────────────────
export type LineResolution = {
  line: ParsedPoLine;
  base?: StyleLite;     // matched non-PPK variant
  ppk?: StyleLite;      // matched PPK variant
  chosen?: StyleLite;   // final pick (undefined while ambiguous / unmatched)
  ambiguous: boolean;   // both a base and a PPK variant exist; operator must pick
  matched: boolean;     // at least one style matched
};

/**
 * Split a combined "STYLE-COLOR" code (e.g. "RYB187810-OPEN SEA") into the
 * longest style_code that is a real style + the trailing remainder as a color.
 * The match must end on a separator boundary (-, _, /, space) so "RYB1878"
 * doesn't wrongly match "RYB187810…". Returns null when nothing splits.
 */
function splitCombinedCode(raw: string, styles: StyleLite[]): { code: string; color: string | null } | null {
  const up = raw.toUpperCase();
  let best: StyleLite | null = null;
  for (const s of styles) {
    const sc = s.style_code.toUpperCase();
    if (up.length > sc.length && up.startsWith(sc) && /[-_/\s]/.test(up.charAt(sc.length))) {
      if (!best || sc.length > best.style_code.length) best = s;
    }
  }
  if (!best) return null;
  const color = raw.slice(best.style_code.length).replace(/^[-_/\s]+/, "").trim() || null;
  return { code: best.style_code, color };
}

/** Resolve one parsed line to a style, detecting base-vs-PPK ambiguity. */
export function resolveLine(line: ParsedPoLine, styles: StyleLite[]): LineResolution {
  const raw = (line.style_code || "").trim();
  if (!raw) return { line, ambiguous: false, matched: false };

  let code = raw;
  let outLine = line;
  // Direct match on the code as-is?
  const baseRaw = baseStyleCode(raw).toUpperCase();
  const directHit = styles.some((s) => baseStyleCode(s.style_code).toUpperCase() === baseRaw);
  if (!directHit) {
    // Try to peel a "STYLE-COLOR" combined code — the customer's PO often writes
    // e.g. "RYB187810-OPEN SEA" as one token.
    const split = splitCombinedCode(raw, styles);
    if (split) {
      code = split.code;
      // Use the peeled color only when the line didn't already carry one.
      outLine = { ...line, style_code: split.code, color: line.color || split.color };
    }
  }

  const baseC = baseStyleCode(code).toUpperCase();
  const sameBase = styles.filter((s) => baseStyleCode(s.style_code).toUpperCase() === baseC);
  const ppk = sameBase.find((s) => isPpkStyle(s.style_code));
  const base = sameBase.find((s) => !isPpkStyle(s.style_code));
  // The PO explicitly names a PPK style → use PPK, no question.
  if (isPpkStyle(code) && ppk) return { line: outLine, base, ppk, chosen: ppk, ambiguous: false, matched: true };
  // Both variants exist and the PO used the base form → ask the operator.
  if (base && ppk) return { line: outLine, base, ppk, ambiguous: true, matched: true };
  const only = base || ppk;
  return { line: outLine, base, ppk, chosen: only, ambiguous: false, matched: !!only };
}

// ── Resolved lines → matrix seed + warnings ──────────────────────────────────
type Cell = { color: string | null; size: string; qty: number; unit?: string };

/**
 * Build the matrix seed from lines that have a chosen style. `fetchSizes`
 * returns the style's matrix size columns (from /api/internal/style-matrix).
 */
export async function buildSeedFromResolved(
  resolved: { line: ParsedPoLine; chosen: StyleLite }[],
  fetchSizes: (styleId: string) => Promise<string[]>,
): Promise<{ sections: SeedSection[]; warnings: PrefillWarning[] }> {
  const byStyle = new Map<string, Cell[]>();
  const warnings: PrefillWarning[] = [];

  for (const { line, chosen } of resolved) {
    let sizes: string[] = [];
    try { sizes = await fetchSizes(chosen.id); } catch { /* leave empty → warn below */ }
    const color = line.color || null;
    const unit = line.unit_price != null ? String(line.unit_price) : undefined;
    const total = line.total_qty != null ? Math.max(0, Math.floor(line.total_qty)) : 0;
    const cells: Cell[] = [];

    if (isPpkStyle(chosen.style_code)) {
      // PPK: a single PPK<N> size column; the cell value is a CARTON count.
      const ppkSize = sizes.find((s) => /PPK/i.test(s)) || sizes[0] || "";
      const per = extractPpk(ppkSize) || extractPpk(chosen.style_code) || 0;
      if (ppkSize && per > 0 && total > 0) {
        const cartons = Math.ceil(total / per);
        cells.push({ color, size: ppkSize, qty: cartons, unit });
        if (total % per !== 0) {
          warnings.push({ style: chosen.style_code, detail: `${color || ""} ${total} units ÷ ${per}/carton → ${cartons} cartons (rounded up from ${(total / per).toFixed(2)}).` });
        }
      } else if (total > 0) {
        warnings.push({ style: chosen.style_code, detail: `Couldn't determine the PPK carton size — left blank, enter cartons manually.` });
      }
    } else {
      // Keep only size-breakdown rows that map to a REAL size column. Rows like
      // "AST" / "ASSORTED" / "PREPACK" (a prepack/nested order with no per-size
      // split) don't match a column, so they're rolled into the total instead of
      // creating an invisible cell that drops the quantity (and the price).
      const realBreakdown = (line.size_breakdown || [])
        .map((sb) => ({ size: sizes.find((s) => s.toLowerCase() === sb.size.toLowerCase()), qty: Math.max(0, Math.floor(sb.qty)) }))
        .filter((x): x is { size: string; qty: number } => !!x.size && x.qty > 0);

      if (realBreakdown.length > 0) {
        // Exact per-size quantities; flag any partial carton of 24.
        for (const x of realBreakdown) {
          cells.push({ color, size: x.size, qty: x.qty, unit });
          if (isPartialCarton(x.qty)) warnings.push({ style: chosen.style_code, detail: `${color || ""} ${x.size}: ${x.qty} is not a full carton of 24.` });
        }
      } else {
        // No usable per-size split — use the total (or sum the assorted breakdown)
        // and distribute across the sizes via the style's size scale.
        const fromBreakdown = (line.size_breakdown || []).reduce((s, sb) => s + Math.max(0, Math.floor(sb.qty)), 0);
        const effectiveTotal = total > 0 ? total : fromBreakdown;
        if (effectiveTotal > 0) {
          const pack: SizePack = chosen.attributes?.size_scale_pack || {};
          if (hasUsablePack(sizes, pack)) {
            const dist = distributeByPack(effectiveTotal, sizes, pack);
            for (const [size, q] of Object.entries(dist)) if (q > 0) cells.push({ color, size, qty: q, unit });
          } else if (sizes[0]) {
            // No scale to distribute by — drop the total on the first size and warn.
            cells.push({ color, size: sizes[0], qty: effectiveTotal, unit });
            warnings.push({ style: chosen.style_code, detail: `No size scale set — put ${effectiveTotal} units on size ${sizes[0]}; split it across sizes manually (or set a Scale in Style Master).` });
          } else {
            warnings.push({ style: chosen.style_code, detail: `${effectiveTotal} units, but the style has no size scale / sizes — add it manually.` });
          }
        }
      }
    }

    if (cells.length) {
      if (!byStyle.has(chosen.style_code)) byStyle.set(chosen.style_code, []);
      byStyle.get(chosen.style_code)!.push(...cells);
    }
  }

  const sections: SeedSection[] = [...byStyle.entries()].map(([styleCode, cells]) => ({
    styleCode,
    cells: cells.map((c) => ({ color: c.color, size: c.size, qty: c.qty, unit: c.unit })),
  }));
  return { sections, warnings };
}

// ── Header matching ──────────────────────────────────────────────────────────
export function matchCustomer(name: string | null, customers: { id: string; name: string; customer_code?: string | null }[]): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const exact = customers.find((c) => c.name.trim().toLowerCase() === n);
  if (exact) return exact.id;
  const partial = customers.find((c) => c.name.trim().toLowerCase().includes(n) || n.includes(c.name.trim().toLowerCase()));
  return partial?.id || null;
}

/** Net-days from a terms string: "30 days" / "net 30" / "n30" / "2/10 net 30" → 30. */
export function netDaysOf(s: string | null | undefined): number | null {
  if (!s) return null;
  const str = String(s).toLowerCase();
  const net = str.match(/net\s*(\d{1,3})/);           // "net 30", "2/10 net 30"
  if (net) return parseInt(net[1], 10);
  const days = str.match(/(\d{1,3})\s*days?\b/);       // "30 days"
  if (days) return parseInt(days[1], 10);
  const nN = str.match(/^n\s*(\d{1,3})$/);             // "n30"
  if (nN) return parseInt(nN[1], 10);
  return null;
}

export function matchPaymentTerms(terms: string | null, list: { id: string; code?: string; name: string }[]): string | null {
  if (!terms) return null;
  const t = terms.trim().toLowerCase();
  if (!t) return null;
  // 1) Exact / substring on name or code.
  const hit = list.find((p) => p.name.toLowerCase() === t || (p.code || "").toLowerCase() === t
    || p.name.toLowerCase().includes(t) || t.includes(p.name.toLowerCase()));
  if (hit) return hit.id;
  // 2) Loose: match on the net-days number — "30 DAYS" finds "Net 30".
  const days = netDaysOf(t);
  if (days != null) {
    const byDays = list.find((p) => netDaysOf(p.name) === days || netDaysOf(p.code) === days);
    if (byDays) return byDays.id;
  }
  return null;
}

/** Normalize a parsed date to YYYY-MM-DD or "" (the model is told to ISO it). */
export function isoDate(d: string | null): string {
  if (!d) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : "";
}
