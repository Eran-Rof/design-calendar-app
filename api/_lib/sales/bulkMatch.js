// api/_lib/sales/bulkMatch.js
//
// Lot numbers — Scenario 4.2: match a distro customer PO against a bulk order by
// STYLE/COLOR. A bulk order (one large customer PO) is later subdivided into
// several distro customer POs; when a distro arrives we want to know how much of
// it (and how much of the bulk) the two share, so the operator can decide to
// cancel the now-superseded bulk.
//
// Pure + deterministic. "Match" is computed at the style+color grain (sizes are
// ignored per the operator's rule), as the overlapping units between the two.

/** Canonical style+color key (case/space-insensitive). */
export function styleColorKey(style_code, color) {
  return `${String(style_code ?? "").trim().toUpperCase()}|${String(color ?? "").trim().toUpperCase()}`;
}

/** Sum line quantities per style+color. Lines without a style_code are skipped. */
export function aggregateByStyleColor(lines) {
  const m = new Map();
  for (const l of lines || []) {
    if (!l.style_code) continue;
    const key = styleColorKey(l.style_code, l.color);
    const q = Math.max(0, Number(l.qty) || 0);
    if (!m.has(key)) m.set(key, { style_code: l.style_code, color: l.color ?? null, qty: 0 });
    m.get(key).qty += q;
  }
  return m;
}

/**
 * Compare a bulk order's lines to a distro's lines by style/color.
 *
 * @param {{style_code?:string|null, color?:string|null, qty:number}[]} bulkLines
 * @param {{style_code?:string|null, color?:string|null, qty:number}[]} distroLines
 * @returns {{
 *   matched_units:number, bulk_units:number, distro_units:number,
 *   match_pct:number,            // matched ÷ distro units (how much of the distro the bulk covers)
 *   bulk_coverage_pct:number,    // matched ÷ bulk units (how much of the bulk this distro covers)
 *   breakdown:{style_code:string, color:string|null, bulk_qty:number, distro_qty:number, matched:number}[]
 * }}
 */
export function computeBulkMatch(bulkLines, distroLines) {
  const bulk = aggregateByStyleColor(bulkLines);
  const distro = aggregateByStyleColor(distroLines);
  const keys = new Set([...bulk.keys(), ...distro.keys()]);
  const breakdown = [];
  let matched = 0, bulkUnits = 0, distroUnits = 0;
  for (const k of keys) {
    const b = bulk.get(k)?.qty || 0;
    const d = distro.get(k)?.qty || 0;
    const m = Math.min(b, d);
    matched += m; bulkUnits += b; distroUnits += d;
    const ref = bulk.get(k) || distro.get(k);
    breakdown.push({ style_code: ref.style_code, color: ref.color ?? null, bulk_qty: b, distro_qty: d, matched: m });
  }
  breakdown.sort((a, b) => (b.matched - a.matched) || String(a.style_code).localeCompare(String(b.style_code)) || String(a.color ?? "").localeCompare(String(b.color ?? "")));
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
  return {
    matched_units: matched,
    bulk_units: bulkUnits,
    distro_units: distroUnits,
    match_pct: pct(matched, distroUnits),
    bulk_coverage_pct: pct(matched, bulkUnits),
    breakdown,
  };
}
