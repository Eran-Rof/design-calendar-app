// api/_lib/sizeScaleMatch.js
//
// Pure best-available matcher: given a style's raw size variants (and optionally
// its gender), pick the size_scale that best fits. Used by the bulk
// "auto-assign size scales" tool so the operator doesn't hand-pick a scale for
// every style. No DB / no I/O — unit-tested in api/_lib/__tests__.
//
// Strategy: canonicalise both the style's variants and each scale's sizes to a
// comparable token, count how many variants the scale covers, and pick the
// highest-coverage scale (tie-broken by gender affinity, then tightest fit).
// "Best available" — an imperfect-but-clear winner is assigned; genuinely weak
// or ambiguous cases (too few sizes, low coverage) are left unassigned.

// Alpha size synonyms → one canonical token. The 2026-07-22 CEO scale-gap
// annotations endorsed a few more equivalences whose scales spell the size the
// other way round from the SKU: SL≡SMALL, 3X≡3XLARGE, 4XLARGE≡4XL,
// the 5XL family, and Asst≡Assorted. Kept in lock-step with
// LETTER_SIZE_CANON in styleMatrix.js (same token set, matrix-label canon).
const ALPHA = new Map([
  ["XXS", "XXS"], ["2XS", "XXS"],
  ["XS", "XS"], ["XSM", "XS"], ["XSML", "XS"], ["XSMALL", "XS"], ["X-SMALL", "XS"],
  ["S", "S"], ["SM", "S"], ["SML", "S"], ["SL", "S"], ["SMALL", "S"],
  ["M", "M"], ["MED", "M"], ["MEDIUM", "M"],
  ["L", "L"], ["LG", "L"], ["LRG", "L"], ["LARGE", "L"],
  ["XL", "XL"], ["XLG", "XL"], ["XLRG", "XL"], ["XLARGE", "XL"], ["X-LARGE", "XL"],
  ["XXL", "2XL"], ["2XL", "2XL"], ["2X", "2XL"], ["2XLARGE", "2XL"], ["XXLARGE", "2XL"],
  ["XXXL", "3XL"], ["3XL", "3XL"], ["3X", "3XL"], ["3XLARGE", "3XL"],
  ["XXXXL", "4XL"], ["4XL", "4XL"], ["4X", "4XL"], ["4XLARGE", "4XL"],
  ["XXXXXL", "5XL"], ["5XL", "5XL"], ["5X", "5XL"], ["5XLARGE", "5XL"],
  ["ASS", "ASSORTED"], ["ASST", "ASSORTED"], ["ASSORTED", "ASSORTED"],
  ["OS", "OS"], ["ONESIZE", "OS"], ["ONE SIZE", "OS"], ["O/S", "OS"], ["OSFA", "OS"],
]);

// Canonical form(s) of one raw size token. Combined tokens like "L/12" yield
// BOTH forms so the variant can match an alpha OR a numeric scale.
export function canonToken(raw) {
  const t = String(raw == null ? "" : raw).toUpperCase().trim();
  if (!t) return [];
  // ALPHA first: "O/S" means One Size — splitting it on the slash (as the
  // generic combined-token rule below would) yielded ["O","S"] and made every
  // One-Size scale look like it was missing its own size (85 false positives
  // in the 2026-07-21 scale-gap audit).
  if (ALPHA.has(t)) return [ALPHA.get(t)];          // alpha synonym (incl. O/S)
  if (t.includes("/")) return [...new Set(t.split("/").flatMap((p) => canonToken(p)))];
  if (/^\d+(\.\d+)?$/.test(t)) return [t];          // pure numeric (waist / women's)
  // Infant month sizes: SKUs say "12MO"/"18MO", scales say "12M"/"18M" — same
  // size. Canonical = the scale spelling (digits + "M").
  const mo = t.replace(/\s+/g, "").match(/^(\d+)MOS?$/);
  if (mo) return [`${mo[1]}M`];
  return [t.replace(/\s+/g, "")];                   // structured (2T, 12M, 0-3M, …)
}

function canonSet(sizes) {
  const s = new Set();
  for (const z of sizes || []) for (const f of canonToken(z)) s.add(f);
  return s;
}

// Rough gender affinity of a scale, from its code/name.
function scaleAffinity(scale) {
  const s = `${scale.code || ""} ${scale.name || ""}`.toUpperCase();
  if (/KID|TODDLER|INFANT|YOUTH|BOY|GIRL/.test(s)) return "child";
  if (/WOMEN|WMN|LADIES|MISSES/.test(s)) return "W";
  if (/MEN/.test(s)) return "M"; // WOMEN already caught above
  return null; // neutral (denim, one-size, numeric)
}

// Map a style gender code to a coarse class for affinity comparison.
function genderClass(gender) {
  const g = String(gender || "").toUpperCase().trim();
  if (!g) return null;
  if (["C", "B", "G", "K", "Y", "T", "I"].includes(g)) return "child";
  if (g === "W" || g === "F") return "W";
  if (g === "M") return "M";
  return null; // U / unisex / other → no affinity
}

const MIN_COVERAGE = 0.6;   // scale must cover ≥60% of the style's variants
const MIN_MATCHED = 3;      // …and ≥3 distinct sizes — a real size run, not a
                            // single or a weak 2-size pair ("full scale, not single").

// scales: [{ id, code, name, sizes: string[] }]
// Returns { size_scale_id, code, name, score, matched, total, reason } or
// { size_scale_id: null, reason } when nothing confident fits.
export function bestScaleFor(variants, scales, gender) {
  const styleForms = (variants || [])
    .map((v) => ({ raw: v, forms: canonToken(v) }))
    .filter((sv) => sv.forms.length);
  const total = styleForms.length;
  if (!total) return { size_scale_id: null, reason: "no_variants" };

  // Single-size special case: only confidently a one-size scale.
  const allOS = styleForms.every((sv) => sv.forms.includes("OS"));
  const gClass = genderClass(gender);

  let best = null;
  for (const scale of scales || []) {
    const sc = canonSet(scale.sizes);
    if (!sc.size) continue;
    let matched = 0;
    for (const sv of styleForms) if (sv.forms.some((f) => sc.has(f))) matched++;
    if (!matched) continue;
    const coverage = matched / total;
    const extra = sc.size - matched;                 // scale sizes the style lacks
    const aff = scaleAffinity(scale);
    const genderBonus = aff && gClass && aff === gClass ? 0.15 : 0;
    const genderPenalty = aff && gClass && aff !== gClass ? 0.1 : 0;
    const score = coverage + genderBonus - genderPenalty;
    const cand = { scale, matched, coverage, extra, score };
    if (!best ||
        cand.score > best.score ||
        (cand.score === best.score && cand.extra < best.extra) ||
        (cand.score === best.score && cand.extra === best.extra && cand.scale.sizes.length < best.scale.sizes.length) ||
        (cand.score === best.score && cand.extra === best.extra && cand.scale.sizes.length === best.scale.sizes.length && String(cand.scale.code) < String(best.scale.code))) {
      best = cand;
    }
  }

  if (!best) return { size_scale_id: null, reason: "no_overlap" };

  // Confidence gates. Allow a single OS size only for a one-size scale.
  const isOneSize = best.scale.sizes.length === 1 && canonSet(best.scale.sizes).has("OS");
  if (allOS && isOneSize) {
    return mk(best, total, "one_size");
  }
  if (best.matched < MIN_MATCHED) return { size_scale_id: null, reason: "too_few_sizes" };
  if (best.coverage < MIN_COVERAGE) return { size_scale_id: null, reason: "low_coverage" };
  return mk(best, total, best.coverage === 1 ? "exact_cover" : "best_available");
}

function mk(best, total, reason) {
  return {
    size_scale_id: best.scale.id,
    code: best.scale.code,
    name: best.scale.name,
    score: Math.round(best.score * 100) / 100,
    matched: best.matched,
    total,
    reason,
  };
}
