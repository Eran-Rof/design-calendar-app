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
import { distributeByPack, hasUsablePack, isPartialCarton, packForInseam, type SizePack, type NestedSizePack } from "../../shared/sizeScale";

export type ParsedPoLine = {
  style_code: string | null;
  color: string | null;
  description: string | null;
  unit_price: number | null;
  total_qty: number | null;
  /** True when total_qty counts PACKS/PREPACKS/CARTONS, not individual units. */
  qty_is_packs?: boolean;
  size_breakdown: { size: string; qty: number }[] | null;
};
export type ParsedPo = {
  customer_name: string | null;
  customer_po_number: string | null;
  payment_terms: string | null;
  start_ship_date: string | null;
  cancel_date: string | null;
  currency: string;
  /** "ats" | "production" | null — how the order is fulfilled, if stated. */
  fulfillment_source?: string | null;
  /** True when the sender asked for a placeholder/temporary PO (app generates one). */
  use_placeholder_po?: boolean;
  lines: ParsedPoLine[];
};

export type StyleLite = {
  id: string;
  style_code: string;
  style_name?: string | null;
  attributes?: { size_scale_pack?: SizePack | NestedSizePack } | null;
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
type Cell = { color: string | null; size: string; qty: number; unit?: string; inseam?: string | null };

/**
 * Match the PO's colour text to one of the style's ACTUAL colours so the
 * quantity lands on a rendered matrix row. Single-colour styles always map.
 * Otherwise: exact (case-insensitive), then best token-overlap, else the PO text.
 */
export function matchColor(poColor: string | null, actualColors: string[]): string | null {
  if (actualColors.length === 1) return actualColors[0];
  if (!actualColors.length) return poColor;
  if (!poColor) return null;
  const pc = poColor.toLowerCase().trim();
  const exact = actualColors.find((c) => c.toLowerCase().trim() === pc);
  if (exact) return exact;
  const toks = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  const pcToks = toks(pc);
  let best: string | null = null, bestScore = 0;
  for (const c of actualColors) {
    let score = 0;
    for (const t of toks(c)) if (pcToks.has(t)) score++;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  // Never fall back to the raw PO text: a colour that isn't one of the style's
  // actual colours has no rendered matrix row, so the distributed quantity (and
  // its price) would silently vanish onto a phantom row. Land it on the first
  // real colour instead (visible + operator-correctable; a warning is raised at
  // the call site whenever the mapping isn't an exact match).
  return bestScore > 0 ? best : actualColors[0];
}

/** Key for a per-line colour override: style code + the PO's colour text (lower). */
export function colorPickKey(styleCode: string, lineColor: string | null): string {
  return `${styleCode}|${(lineColor || "").toLowerCase().trim()}`;
}

/**
 * Build the matrix seed from lines that have a chosen style. `fetchMatrix`
 * returns the style's matrix size columns + colours (from /api/internal/style-matrix).
 */
export async function buildSeedFromResolved(
  resolved: { line: ParsedPoLine; chosen: StyleLite }[],
  fetchMatrix: (styleId: string) => Promise<{ sizes: string[]; colors: string[]; inseams?: string[] }>,
  // Operator-confirmed colour rows (from the "confirm choices" step), keyed by
  // colorPickKey(styleCode, lineColor). A confirmed pick is used as-is and never
  // raises a "mapped to" warning.
  colorPicks: Record<string, string> = {},
): Promise<{ sections: SeedSection[]; warnings: PrefillWarning[] }> {
  const byStyle = new Map<string, Cell[]>();
  // Per style+colour total to show in the matrix Qty quick-fill box (assorted /
  // total lines that were spread across the sizes from one number).
  const quickFillByStyle = new Map<string, Record<string, number>>();
  const warnings: PrefillWarning[] = [];

  for (const { line, chosen } of resolved) {
    let sizes: string[] = [];
    let colors: string[] = [];
    let inseams: string[] | undefined;
    try { ({ sizes, colors, inseams } = await fetchMatrix(chosen.id)); } catch { /* leave empty → warn below */ }
    // The matrix body keys every row by the SKU's real inseam when the style HAS
    // inseams. A PO upload carries no inseam context, so seed onto the style's
    // representative (first) inseam — otherwise the cell (qty + price) lands on a
    // rowKey the body never renders and silently disappears.
    const seedInseam: string | null = inseams && inseams.length ? inseams[0] : null;
    // An operator-confirmed colour row (from the confirm-choices step) wins and
    // is never re-warned; otherwise fall back to the fuzzy match.
    const picked = colorPicks[colorPickKey(chosen.style_code, line.color)];
    const colorConfirmed = !!picked && colors.includes(picked);
    const color = colorConfirmed ? picked : matchColor(line.color, colors);
    // Warn when the PO's colour text was mapped onto a different style colour
    // (token-overlap or the first-colour fallback) so the operator verifies the
    // placement — single-colour styles, exact matches, and confirmed picks don't warn.
    if (!colorConfirmed && line.color && colors.length > 1 && color && color.toLowerCase().trim() !== line.color.toLowerCase().trim()) {
      warnings.push({ style: chosen.style_code, detail: `PO colour "${line.color}" mapped to "${color}" — verify it's the right colour row.` });
    }
    const unit = line.unit_price != null ? String(line.unit_price) : undefined;
    const total = line.total_qty != null ? Math.max(0, Math.floor(line.total_qty)) : 0;
    // Fall back to a summed size-breakdown when the line carries no scalar total
    // (some POs give only the per-size rows, even for PPK/assorted lines).
    const fromBreakdown = (line.size_breakdown || []).reduce((s, sb) => s + Math.max(0, Math.floor(sb.qty)), 0);
    const effectiveTotal = total > 0 ? total : fromBreakdown;
    const cells: Cell[] = [];

    if (isPpkStyle(chosen.style_code)) {
      // PPK: a single PPK<N> size column; the cell value is a CARTON (pack) count.
      // `sizes` carries the pack token (e.g. "PPK24") from the matrix even when the
      // style_code has no digits (RYB0594PPK); fall back to the style code.
      const ppkSize = sizes.find((s) => /PPK/i.test(s)) || sizes[0] || "";
      const per = extractPpk(ppkSize) || extractPpk(chosen.style_code) || 0;
      if (effectiveTotal > 0 && ppkSize) {
        if (line.qty_is_packs) {
          // The PO already states a PACK count — seed it directly, no division.
          cells.push({ color, size: ppkSize, qty: effectiveTotal, unit });
        } else if (per > 0) {
          // The PO states UNITS — convert to cartons via the pack size.
          const cartons = Math.ceil(effectiveTotal / per);
          cells.push({ color, size: ppkSize, qty: cartons, unit });
          if (effectiveTotal % per !== 0) {
            warnings.push({ style: chosen.style_code, detail: `${color || ""} ${effectiveTotal} units ÷ ${per}/carton → ${cartons} cartons (rounded up from ${(effectiveTotal / per).toFixed(2)}).` });
          }
        } else {
          // Units, but no pack size known — drop the count on the pack column and warn.
          cells.push({ color, size: ppkSize, qty: effectiveTotal, unit });
          warnings.push({ style: chosen.style_code, detail: `Couldn't read the pack size for this prepack — entered ${effectiveTotal} as the pack count; verify it's packs not units.` });
        }
      } else if (effectiveTotal > 0) {
        warnings.push({ style: chosen.style_code, detail: `Couldn't determine the PPK carton column — left blank, enter cartons manually.` });
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
        // No usable per-size split — use the total (or the summed assorted
        // breakdown) and distribute across the sizes via the style's size scale.
        if (effectiveTotal > 0) {
          // Show the source total in this colour's Qty quick-fill box.
          if (!quickFillByStyle.has(chosen.style_code)) quickFillByStyle.set(chosen.style_code, {});
          quickFillByStyle.get(chosen.style_code)![color || ""] = effectiveTotal;
          // PO uploads carry no inseam context, so use the style's representative
          // pack (flat pack as-is, or the first inseam column when per-inseam).
          const pack: SizePack = packForInseam(chosen.attributes?.size_scale_pack, null);
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
      // Stamp the representative inseam so the cells key onto the body's rendered
      // rows (the body keys by inseam whenever the style has one).
      for (const cell of cells) cell.inseam = seedInseam;
      if (!byStyle.has(chosen.style_code)) byStyle.set(chosen.style_code, []);
      byStyle.get(chosen.style_code)!.push(...cells);
    }
  }

  const sections: SeedSection[] = [...byStyle.entries()].map(([styleCode, cells]) => ({
    styleCode,
    cells: cells.map((c) => ({ color: c.color, size: c.size, inseam: c.inseam ?? null, qty: c.qty, unit: c.unit })),
    quickFill: quickFillByStyle.get(styleCode),
  }));
  return { sections, warnings };
}

// ── Colour disambiguation (for the "confirm choices" step) ───────────────────
export type ColorQuestion = {
  styleCode: string;
  styleId: string;
  lineColor: string;   // the PO's colour text
  suggested: string;   // the fuzzy-matched colour row (default pick)
  options: string[];   // the style's actual colour rows to choose from
};

/**
 * Find the lines whose PO colour text did NOT map cleanly onto one of the
 * style's actual colour rows — these are the ones the operator should confirm
 * before the seed is built. Single-colour styles and exact matches are skipped
 * (no question). Uses the same `matchColor` rule as the seed builder so the
 * default pick matches what would have been auto-chosen. fetchMatrix is cached
 * by the caller, so this does not double-fetch when the seed is later built.
 */
export async function computeColorQuestions(
  resolved: { line: ParsedPoLine; chosen: StyleLite }[],
  fetchMatrix: (styleId: string) => Promise<{ sizes: string[]; colors: string[]; inseams?: string[] }>,
): Promise<ColorQuestion[]> {
  const out: ColorQuestion[] = [];
  const seen = new Set<string>();
  for (const { line, chosen } of resolved) {
    if (!line.color) continue;
    const key = colorPickKey(chosen.style_code, line.color);
    if (seen.has(key)) continue;      // same style+colour on >1 line → ask once
    let colors: string[] = [];
    try { ({ colors } = await fetchMatrix(chosen.id)); } catch { continue; }
    if (colors.length <= 1) continue;
    const mapped = matchColor(line.color, colors);
    if (mapped && mapped.toLowerCase().trim() !== line.color.toLowerCase().trim()) {
      seen.add(key);
      out.push({ styleCode: chosen.style_code, styleId: chosen.id, lineColor: line.color, suggested: mapped, options: colors });
    }
  }
  return out;
}

// ── Header matching ──────────────────────────────────────────────────────────
type CustomerLite = { id: string; name: string; customer_code?: string | null };

/** Exact (case-insensitive) customer-name match only — no fuzzy fallback. */
export function matchCustomerExact(name: string | null, customers: CustomerLite[]): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const exact = customers.find((c) => c.name.trim().toLowerCase() === n);
  return exact?.id || null;
}

/**
 * Ranked customer candidates for the "confirm choices" step when the parsed name
 * isn't an exact match: exact > prefix > substring > token-overlap. Returns up to
 * `limit` so the operator can pick the right one (the full searchable list is the
 * ultimate fallback in the UI).
 */
export function customerCandidates(name: string | null, customers: CustomerLite[], limit = 6): { id: string; name: string }[] {
  if (!name) return [];
  const n = name.trim().toLowerCase();
  if (!n) return [];
  const toks = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  const nToks = toks(n);
  const scored = customers.map((c) => {
    const cn = c.name.trim().toLowerCase();
    let score = 0;
    if (cn === n) score = 100;
    else if (cn.startsWith(n) || n.startsWith(cn)) score = 80;
    else if (cn.includes(n) || n.includes(cn)) score = 60;
    else { let ov = 0; for (const t of toks(cn)) if (nToks.has(t)) ov++; score = ov > 0 ? 20 + ov : 0; }
    return { c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return scored.map((x) => ({ id: x.c.id, name: x.c.name }));
}

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

/** True when a terms string carries an early-payment discount (e.g. "2%", "2/10"). */
function hasDiscount(s: string | null | undefined): boolean {
  return /\d\s*%|\d\s*\/\s*\d/.test(String(s || ""));
}

export function matchPaymentTerms(terms: string | null, list: { id: string; code?: string; name: string }[]): string | null {
  if (!terms) return null;
  const t = terms.trim().toLowerCase();
  if (!t) return null;
  // When the PO term has no early-pay discount, skip discount terms ("2% Net 30")
  // and go to the next — a plain "Net 30" should match plain "Net 30".
  const parsedDisc = hasDiscount(t);
  const ok = (p: { name: string }) => parsedDisc || !hasDiscount(p.name);
  const byLen = (a: { name: string }, b: { name: string }) => a.name.length - b.name.length;

  // 1) Exact name / code (discount-filtered).
  const exact = list.find((p) => ok(p) && (p.name.toLowerCase() === t || (p.code || "").toLowerCase() === t));
  if (exact) return exact.id;
  // 2) Same net-days — "30 DAYS" → "Net 30". Shortest name wins so the plain
  //    term beats a discount variant; discount terms already filtered out.
  const days = netDaysOf(t);
  if (days != null) {
    const byDays = list.filter((p) => ok(p) && (netDaysOf(p.name) === days || netDaysOf(p.code) === days)).sort(byLen);
    if (byDays.length) return byDays[0].id;
  }
  // 3) Substring containment, last resort (discount-filtered, shortest wins).
  const sub = list.filter((p) => ok(p) && (p.name.toLowerCase().includes(t) || t.includes(p.name.toLowerCase()))).sort(byLen);
  if (sub.length) return sub[0].id;
  return null;
}

/**
 * Normalize a parsed date to YYYY-MM-DD. The model is told to ISO-format dates,
 * but it isn't guaranteed to — so accept a US MM/DD/YYYY (or M/D/YY) date too and
 * convert it MONTH-first (the app-wide US convention) rather than silently
 * dropping it. Anything else → "".
 */
export function isoDate(d: string | null): string {
  if (!d) return "";
  const s = d.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (us) {
    const mm = us[1].padStart(2, "0"), dd = us[2].padStart(2, "0");
    let yyyy = us[3];
    if (yyyy.length === 2) yyyy = `20${yyyy}`;
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) return `${yyyy}-${mm}-${dd}`;
  }
  return "";
}
