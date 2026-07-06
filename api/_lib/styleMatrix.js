// api/_lib/styleMatrix.js
//
// Shared helpers for the size-matrix surfaces (inventory view, SO entry,
// inventory adjustments, PO entry). One source of truth so every surface
// renders the same color × size (× inseam) grid for a style.
//
//   enumerateStyleMatrix(admin, entityId, styleId)
//     → { style, sizes, colors, inseams, rises,
//         skus:[{id,sku_code,color,size,inseam,length,fit,rise,on_hand_qty,available_qty,avg_cost_cents,last_received}] }
//     `sizes` comes from the style's size_scale (ordered); falls back to the
//     distinct sizes on existing SKUs when the style has no scale.
//
//   resolveOrCreateSku(admin, entityId, { style_id, style_code, color, size, inseam })
//     → { id, created }  — finds the sized SKU for (style,color,size,inseam) or
//     creates it (matrix cells auto-materialize SKUs on first use).

const SKU_SAFE = (s) => String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Canonical letter-size labels (match the size_scales master: "Mens S–2XL" =
// SMALL/MEDIUM/LARGE/XLARGE/2XLARGE, "Kids XS–XL" = XSMALL…). The catalog's
// ip_item_master.size carries Xoro abbreviations (SML/MED/LRG/XLG/XXL/…) and a
// mix of single-letter forms (S/M/L/XL) that DON'T line up with the scale
// columns, so a letter-size style renders columns its SKUs can't match. We map
// every variant to one canonical label for the matrix VIEW (display + cell
// match). Non-letter tokens (numeric waists, OS, PPKxx, "S/8", "XS(5-6)") pass
// through unchanged. Presentation-only — ip_item_master is NOT mutated.
const LETTER_SIZE_CANON = {
  XS: "XSMALL", XSM: "XSMALL", "X-SMALL": "XSMALL", XSMALL: "XSMALL",
  S: "SMALL", SM: "SMALL", SML: "SMALL", SMALL: "SMALL",
  M: "MEDIUM", MD: "MEDIUM", MED: "MEDIUM", MEDIUM: "MEDIUM",
  L: "LARGE", LG: "LARGE", LRG: "LARGE", LARGE: "LARGE",
  XL: "XLARGE", XLG: "XLARGE", "X-LARGE": "XLARGE", XLARGE: "XLARGE",
  XXL: "2XLARGE", "2X": "2XLARGE", "2XL": "2XLARGE", XXLARGE: "2XLARGE", "2XLARGE": "2XLARGE",
  XXXL: "3XLARGE", "3X": "3XLARGE", "3XL": "3XLARGE", "3XLARGE": "3XLARGE",
};
export function normalizeSize(raw) {
  if (raw == null) return raw;
  return LETTER_SIZE_CANON[String(raw).trim().toUpperCase()] || raw;
}
// Inverse: a canonical label → every raw token that maps to it. Lets the SKU
// resolver MATCH an existing row whatever spelling it was stored with (so a
// caller asking for "SMALL" reuses a legacy "SML"/"S" row instead of forking a
// new one — the root cause of the duplicate-SKU sprawl).
const SIZE_VARIANTS = (() => {
  const m = {};
  for (const [tok, canon] of Object.entries(LETTER_SIZE_CANON)) (m[canon] ||= new Set()).add(tok);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
})();
// All DB size tokens that mean the same size as `raw` (incl. raw itself).
export function sizeVariantsOf(raw) {
  if (raw == null) return [];
  const canon = normalizeSize(raw);
  return SIZE_VARIANTS[canon] || [String(raw).trim()];
}

// Column-ordering rank for a size label on the FALLBACK path (a style with no
// explicit size_scale). Understands letter sizes — including the catalog's kids
// age-range forms like "XS(5-6)" and the canonical XSMALL…3XLARGE labels — plus
// numeric waist sizes. Returns a [tier, rank, tiebreak] tuple: letter sizes
// (tier 0) order XS→…→5XL, numeric waists (tier 1) order by value, anything else
// (tier 2) sorts last alphabetically. Without this the fallback kept raw SKU
// insertion order, so kids styles rendered scrambled columns (XS, L, M, S, XL).
const SIZE_TIER = {
  XXSMALL: -2, XSMALL: -1, SMALL: 0, MEDIUM: 1, LARGE: 2,
  XLARGE: 3, "2XLARGE": 4, "3XLARGE": 5, "4XLARGE": 6, "5XLARGE": 7,
};
export function sizeSortKey(size) {
  const s = String(size ?? "").trim();
  if (!s) return [3, Number.POSITIVE_INFINITY, ""];
  const base = s.split(/[\s(]/)[0];            // "XS(5-6)" -> "XS"; "MEDIUM" -> "MEDIUM"
  const canon = normalizeSize(base);           // "XS" -> "XSMALL"; canonical labels pass through
  if (canon in SIZE_TIER) {
    const lo = (s.match(/\((\d+)/) || [])[1];  // age-range low bound as a tiebreak
    return [0, SIZE_TIER[canon], lo ? Number(lo) : 0];
  }
  if (/^\d+(\.\d+)?$/.test(s)) return [1, Number(s), 0]; // numeric waist
  return [2, Number.POSITIVE_INFINITY, s.toUpperCase()];
}
// Comparator over size labels using sizeSortKey (stable within a tier).
export function compareSizes(a, b) {
  const ka = sizeSortKey(a), kb = sizeSortKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

// Color canonicalization — the SAME physical color arrives from different ingest
// paths spelled differently: CASE ("Black" vs "BLACK"), abbreviation ("Light
// Wash" vs "Lt Wash", "…with Tint" vs "…w Tint"), and punctuation/spacing
// ("Navy/Peach" vs "NAVY/PEACH", "Forget-Me-Not"). The matrix groups rows by the
// raw `color` string, so variants split into duplicate rows (e.g. one color's
// size run spread across two rows). We map every spelling to ONE canonical,
// display-friendly label: uppercase → expand known abbreviations (whole word) →
// collapse punctuation/space → Title Case. DETERMINISTIC (independent of which
// variants are present) so the frontend seed and the backend payload converge on
// the same label. Presentation-only — ip_item_master is NOT mutated; SKUs keep
// their real ids so saves still resolve to the existing row (no forking).
// Mirror: src/tanda/colorCanon.ts — keep in sync.
const COLOR_ABBREV = { LT: "LIGHT", DK: "DARK", MED: "MEDIUM", W: "WITH", WTH: "WITH", BLCK: "BLACK", CBO: "COMBO" };
export function canonColor(raw) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s) return s;
  const words = s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(" ");
  return words
    .map((w) => COLOR_ABBREV[w] || w)
    .map((w) => (w ? w[0] + w.slice(1).toLowerCase() : w))
    .join(" ");
}

// Bucket name for inventory layers that carry no `wh=<Store>` token in `notes`
// (color-grain opening_balance layers predate the by-size warehouse cutover).
const WH_UNASSIGNED = "(unassigned)";

// Bucket label for inventory layers that carry no lot_number (legacy / opening
// balance stock received before lot tracking). Surfaced in the payload `lots`
// list so the UI's lot filter can also isolate unlotted stock.
export const NO_LOT = "(no lot)";
// Normalize a layer's lot_number to the filter/label key (trim; null → NO_LOT).
export function lotKeyOf(v) { const s = v == null ? "" : String(v).trim(); return s === "" ? NO_LOT : s; }

// "Loose" SKU key — uppercase, strip every non-alphanumeric. Used ONLY to
// reconcile the avg-cost grain mismatch (master "NAVY-CAMO" vs costing
// "NAVYCAMO"); both collapse to "NAVYCAMO" here. Never used to write data.
function looseKey(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// PPK stem: strip a trailing PPK token (optionally dash-prefixed, optional
// trailing digits) from a style_code so a SIZED style and its PPK sibling land
// on the same stem. Mirrors src/ats/salesCompsGrain.ts siblingKeyFor().
//   "RYB059430PPK" → "RYB059430"   "RJO0639-PPK" → "RJO0639"
function ppkStem(styleCode) {
  return String(styleCode ?? "").trim().replace(/-?PPK\d*$/i, "").toUpperCase();
}
// Is this style_code a PPK (pack-grain) style? Canonical PPK gate: contains PPK.
function isPpkStyle(styleCode) {
  return /PPK/i.test(String(styleCode ?? ""));
}
export { isPpkStyle };

// Units-per-pack for a set of PPK style_codes, from the prepack_matrices master.
// Returns Map<lower(ppk_style_code), unitsPerPack> where unitsPerPack = Σ
// qty_per_pack across the matrix's sizes. Used by the size-less surfaces
// (Inventory Snapshot + Sold/Purchased drills) to convert PACK quantities into
// EACHES when "Explode PPK" is on: the snapshot has no size axis, so a per-size
// explosion isn't meaningful there — multiplying each pack qty by its
// units-per-pack yields the equivalent each-count for every lifecycle column.
// PPK style_codes with no active matrix are simply omitted (caller leaves those
// rows un-exploded, mirroring the matrix's "unmatched → not exploded" rule).
export async function ppkUnitsPerPackByStyle(admin, entityId, styleCodes) {
  const out = new Map();
  const wanted = [...new Set((styleCodes || []).filter(Boolean).map((c) => String(c)))];
  if (wanted.length === 0) return out;
  const { data: matrices } = await admin
    .from("prepack_matrices")
    .select("id, ppk_style_code")
    .eq("entity_id", entityId)
    .eq("is_active", true)
    .not("ppk_style_code", "is", null);
  const wantedLower = new Set(wanted.map((c) => c.toLowerCase()));
  const matched = (matrices || []).filter((m) => wantedLower.has(String(m.ppk_style_code).toLowerCase()));
  if (matched.length === 0) return out;
  const { data: comp } = await admin
    .from("prepack_matrix_sizes")
    .select("matrix_id, qty_per_pack")
    .in("matrix_id", matched.map((m) => m.id));
  const unitsByMatrix = new Map();
  for (const r of comp || []) {
    unitsByMatrix.set(r.matrix_id, (unitsByMatrix.get(r.matrix_id) || 0) + (Number(r.qty_per_pack) || 0));
  }
  for (const m of matched) {
    const u = unitsByMatrix.get(m.id) || 0;
    if (u > 0) out.set(String(m.ppk_style_code).toLowerCase(), u);
  }
  return out;
}

// Dedupe a list preserving first-seen order (drops falsy entries).
function dedupeOrdered(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) { if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}

/**
 * Build the matrix payload for one style.
 *
 * @param {object}  admin
 * @param {string}  entityId
 * @param {string}  styleId
 * @param {object}  [opts]
 * @param {boolean} [opts.explodePpk=false]  when true, find this SIZED style's
 *        PPK sibling(s), read their pack on-hand, look up each pack's per-size
 *        composition from the prepack_matrices master, and fold the exploded
 *        eaches into the matrix. Adds `explode` metadata to the payload. When a
 *        pack has no matrix defined it is SKIPPED (reported, not guessed). The
 *        un-exploded fields stay exactly as before (backward-compatible).
 */
export async function enumerateStyleMatrix(admin, entityId, styleId, opts = {}) {
  const explodePpk = opts.explodePpk === true;
  // Lot filter (opt-in): when a non-empty list of lot keys is supplied, on-hand
  // is summed only from inventory layers whose lot_number (or NO_LOT) is in the
  // set. The payload's `lots` list is ALWAYS the full set of lots seen (computed
  // regardless of the filter) so the UI dropdown stays populated. `lotsSeen`
  // accumulates the full set across the base layers and any PPK-sibling layers.
  const lotFilter = Array.isArray(opts.lotFilter) && opts.lotFilter.length
    ? new Set(opts.lotFilter.map((s) => lotKeyOf(s)))
    : null;
  const lotsSeen = new Set();
  const { data: style } = await admin
    .from("style_master")
    .select("id, style_code, style_name, description, size_scale_id, brand_id, gender_code, attributes")
    .eq("id", styleId)
    .maybeSingle();
  if (!style) return null;

  // Size columns from the scale (ordered); fallback to distinct SKU sizes.
  let sizes = [];
  if (style.size_scale_id) {
    const { data: scale } = await admin.from("size_scales").select("sizes").eq("id", style.size_scale_id).maybeSingle();
    if (Array.isArray(scale?.sizes)) sizes = scale.sizes.filter(Boolean);
  }

  // Existing sized SKUs for this style.
  const { data: skuRows } = await admin
    .from("ip_item_master")
    .select("id, sku_code, color, size, inseam, length, fit, rise")
    .eq("entity_id", entityId)
    .eq("style_id", styleId);
  const skus = skuRows || [];

  if (sizes.length === 0) {
    const seen = new Set();
    for (const s of skus) { const sz = normalizeSize(s.size); if (sz && !seen.has(sz)) { seen.add(sz); sizes.push(sz); } }
    // No scale to order by → sort into intuitive size order (XS→XL, kids
    // age-ranges, numeric waists) instead of arbitrary SKU insertion order.
    sizes.sort(compareSizes);
  }
  // Canonicalize colors so spelling/case variants of one physical color collapse
  // to a single row (see canonColor). Dedupe preserving first-seen order.
  let colors = dedupeOrdered(skus.map((s) => canonColor(s.color)).filter(Boolean));
  let inseams = [...new Set(skus.map((s) => s.inseam).filter(Boolean))];
  const rises = [...new Set(skus.map((s) => s.rise).filter(Boolean))];

  // Declared colors / inseams from Style Master (style_master.attributes). These
  // render as matrix rows even when no SKU exists yet — so a brand-new style and
  // the AI "Upload customer PO" prefill have color (× inseam) rows to fill into.
  // Declared values lead (operator's order); SKU-derived extras follow, deduped.
  const attrs = style.attributes && typeof style.attributes === "object" ? style.attributes : {};
  const declaredColorIds = Array.isArray(attrs.color_ids)
    ? attrs.color_ids.filter((x) => typeof x === "string" && x)
    : [];
  if (declaredColorIds.length) {
    const { data: cmRows } = await admin
      .from("color_master")
      .select("id, name")
      .eq("entity_id", entityId)
      .in("id", declaredColorIds);
    const nameById = new Map((cmRows || []).map((r) => [r.id, r.name]));
    // Align a declared color to an existing SKU color by canonical key, so the
    // row reuses the (canonical) SKU spelling and its cells resolve. A declared
    // color with no SKU yet contributes its own canonical spelling = empty row.
    const skuColorByCanon = new Map(colors.map((c) => [canonColor(c), c]));
    const declaredNames = declaredColorIds
      .map((id) => nameById.get(id))
      .filter(Boolean)
      .map((n) => skuColorByCanon.get(canonColor(n)) || canonColor(n));
    colors = dedupeOrdered([...declaredNames, ...colors]);
  }
  const declaredInseams = Array.isArray(attrs.inseams)
    ? attrs.inseams.map((x) => String(x).trim()).filter(Boolean)
    : [];
  if (declaredInseams.length) inseams = dedupeOrdered([...declaredInseams, ...inseams]);

  // On-hand (Σ remaining_qty) + available (M18 view) + last-received per item.
  // Per-warehouse on-hand breakdown (additive, backward-compatible): the by-size
  // cutover (RYB0412) tags each layer's warehouse in `notes` as `…:wh=<Store>`
  // (e.g. `wh=ROF Main`, `wh=ROF - ECOM`). Layers with no `wh=` token (e.g.
  // color-grain opening_balance) bucket under WH_UNASSIGNED. `on_hand_qty` stays
  // the FULL sum across all warehouses so existing consumers are unaffected; the
  // breakdown is exposed as the new per-SKU `on_hand_by_wh` map.
  const ids = skus.map((s) => s.id);
  const onHand = new Map();
  const onHandByWh = new Map(); // item_id → { [wh]: qty }
  const whSeen = new Set();
  const avail = new Map();
  const lastReceived = new Map();
  // location_id → warehouse name. Since the multi-warehouse cutover, each layer's
  // location_id is the authoritative warehouse (re-pointed from the legacy `wh=`
  // notes tag). We resolve the name from inventory_locations and fall back to the
  // notes tag only when a layer has no location_id (defensive).
  const locNameById = new Map();
  {
    const { data: locRows } = await admin
      .from("inventory_locations")
      .select("id, name")
      .eq("entity_id", entityId);
    for (const lr of locRows || []) locNameById.set(lr.id, lr.name);
  }
  if (ids.length > 0) {
    const { data: layers } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty, received_at, notes, location_id, lot_number")
      .in("item_id", ids);
    for (const l of layers || []) {
      const q = Number(l.remaining_qty);
      const lot = lotKeyOf(l.lot_number);
      if (q > 0) lotsSeen.add(lot);                 // full lot list (filter-independent)
      const included = !lotFilter || lotFilter.has(lot);
      if (q > 0 && included) {
        onHand.set(l.item_id, (onHand.get(l.item_id) || 0) + q);
        const locName = l.location_id ? locNameById.get(l.location_id) : null;
        const m = (l.notes || "").match(/wh=(.+)$/);
        const wh = locName || (m ? m[1].trim() : WH_UNASSIGNED);
        whSeen.add(wh);
        let byWh = onHandByWh.get(l.item_id);
        if (!byWh) { byWh = {}; onHandByWh.set(l.item_id, byWh); }
        byWh[wh] = (byWh[wh] || 0) + q;
      }
      if (included && l.received_at) {
        const prev = lastReceived.get(l.item_id);
        if (!prev || l.received_at > prev) lastReceived.set(l.item_id, l.received_at);
      }
    }
    // Available (M18 view) is item-level and not lot-aware. When a lot filter is
    // active we deliberately leave `avail` empty so the UI shows only the
    // lot-scoped on-hand rather than a whole-item available that would exceed it.
    if (!lotFilter) {
      const { data: av } = await admin.from("v_inventory_available").select("item_id, available_qty").in("item_id", ids);
      for (const a of av || []) avail.set(a.item_id, Number(a.available_qty));
    }
  }

  // Avg cost: ip_item_avg_cost is keyed by sku_code, storing dollars in avg_cost.
  // Convert to integer cents (×100 round). Degrade silently if table absent.
  //
  // GRAIN MISMATCH (fixed here): the costing sync canonicalizes Xoro item
  // numbers with canonSku (uppercase + spaces REMOVED), so a multi-word color
  // "Navy Camo" becomes "NAVYCAMO" → "RYB0412-NAVYCAMO-30". But ip_item_master
  // stores the same SKU with the space turned into a HYPHEN →
  // "RYB0412-NAVY-CAMO-30". An exact .in() join therefore drops EVERY
  // multi-word-color SKU (~3,660 active SKUs in prod). We fetch the whole
  // style's cost set by style_code prefix and index it BOTH exactly and by a
  // "loose" key (all non-alphanumerics stripped) so those SKUs resolve. Loose
  // collisions were verified non-ambiguous in prod (same cost when keys clash).
  //
  // RENAME-SAFE FETCH: derive cost-row prefixes from the SKUs' OWN sku_codes
  // (segment before the first '-'), NOT style.style_code. After an inseam merge
  // the style was renamed (e.g. RYB086930 → RYB0869) but each SKU kept its
  // original sku_code ("RYB086930-BLACK-30"), so `${style_code}-%` ("RYB0869-%")
  // matched nothing and dropped every cost. A merged style spans several stems
  // (…30/…32/…34) — collect them all and OR the prefixes.
  const avgCostCentsBySku   = new Map(); // exact sku_code → cents
  const avgCostCentsByLoose = new Map(); // looseKey(sku_code) → cents
  const skuStems = [...new Set(
    skus.map((s) => String(s.sku_code ?? "").split("-")[0].trim()).filter(Boolean),
  )];
  if (skuStems.length) {
    const orFilter = skuStems.map((st) => `sku_code.like.${st}-%`).join(",");
    const { data: avgRows, error: avgErr } = await admin
      .from("ip_item_avg_cost")
      .select("sku_code, avg_cost")
      .or(orFilter);
    if (!avgErr) {
      for (const r of avgRows || []) {
        if (r.avg_cost == null) continue;
        const cents = Math.round(Number(r.avg_cost) * 100);
        avgCostCentsBySku.set(r.sku_code, cents);
        const lk = looseKey(r.sku_code);
        if (!avgCostCentsByLoose.has(lk)) avgCostCentsByLoose.set(lk, cents);
      }
    }
  }

  // Warehouses present on this style's layers, in a stable order: known stores
  // alphabetically first, then the unassigned bucket last. Exposed so the UI can
  // build a warehouse filter without re-deriving it from every SKU.
  const whSeenAll = new Set(whSeen);

  // ── Explode PPK (additive, opt-in) ─────────────────────────────────────────
  // The provided style is a SIZED style. Find its PPK sibling style(s) — same
  // stem, style_code contains PPK — read each PPK SKU's pack on-hand per
  // warehouse, look up the pack's per-size composition from prepack_matrices,
  // and emit exploded eaches. Folds into the sized matrix as synthetic cells
  // keyed by (color, size); the UI sums them on top of the real on-hand.
  // Two explode modes:
  //  • SIZED style picked → fold its PPK siblings' packs into its size grid
  //    (additive `explode.cells`, original logic).
  //  • PPK style picked directly (operator searches "ppk") → SELF-explode: turn
  //    THIS style's own pack on-hand into sized eaches via its own matrix and
  //    REPLACE the pack-token column with real size columns.
  let explode = null;
  let selfExplode = null;
  if (explodePpk && isPpkStyle(style.style_code)) {
    selfExplode = await computeSelfPpkExplode(admin, entityId, style, skus, {
      onHand, onHandByWh, lastReceived, avgCostCentsBySku, avgCostCentsByLoose,
    });
  } else if (explodePpk && !isPpkStyle(style.style_code)) {
    explode = await computePpkExplode(admin, entityId, style, whSeenAll, lotFilter, lotsSeen);
  }

  // ── Prepack pack-entry block (additive) ─────────────────────────────────────
  // For a PPK (pack-grain) style, order entry types a single PACK count per
  // color rather than per-size eaches. We surface the pack token (the entry
  // column) and the per-size composition from the Prepack Matrix master so the
  // UI can explode "N packs" into a size breakdown. Computed for every PPK style
  // independent of explodePpk (that flag drives the inventory on-hand explode).
  const prepack = isPpkStyle(style.style_code)
    ? await computePrepackBlock(admin, entityId, style, skus)
    : null;

  const warehouses = [...whSeenAll].filter((w) => w !== WH_UNASSIGNED).sort((a, b) => a.localeCompare(b));
  if (whSeenAll.has(WH_UNASSIGNED)) warehouses.push(WH_UNASSIGNED);

  // Lot numbers present on this style's on-hand (base SKUs + any PPK-sibling
  // packs), sorted; the NO_LOT bucket (unlotted stock) sorts last. Always the
  // FULL set — independent of any active lot filter — so the UI dropdown keeps
  // every choice selectable. Exposed as payload `lots` for the lot filter.
  const lots = [...lotsSeen].filter((l) => l !== NO_LOT).sort((a, b) => a.localeCompare(b));
  if (lotsSeen.has(NO_LOT)) lots.push(NO_LOT);

  // SELF-explode: the picked style IS a PPK and a matrix was found → return the
  // exploded sized matrix in place of the pack-token grid (no double count).
  if (selfExplode) {
    return {
      style: { id: style.id, style_code: style.style_code, style_name: style.style_name, description: style.description, size_scale_id: style.size_scale_id, brand_id: style.brand_id, gender_code: style.gender_code },
      sizes: selfExplode.sizes,
      colors: selfExplode.colors,
      inseams: [],
      rises: [],
      warehouses,
      lots,
      explode: {
        enabled: true,
        self: true,
        cells: [],
        packs_exploded: selfExplode.packsExploded,
        packs_unmatched: selfExplode.unmatched,
        ppk_styles: [style.style_code],
      },
      skus: selfExplode.skus,
    };
  }

  // When exploding, surface any newly-introduced sizes (e.g. a pack composition
  // references a garment size that has no sized SKU yet) so the grid renders a
  // column for it. Append after the scale-ordered sizes, preserving order.
  let outSizes = sizes;
  if (explode && explode.extraSizes.length) {
    outSizes = [...sizes];
    for (const sz of explode.extraSizes) if (!outSizes.includes(sz)) outSizes.push(sz);
  }
  let outColors = colors;
  if (explode && explode.extraColors.length) {
    outColors = [...colors];
    for (const c of explode.extraColors) if (!outColors.includes(c)) outColors.push(c);
  }

  return {
    style: { id: style.id, style_code: style.style_code, style_name: style.style_name, description: style.description, size_scale_id: style.size_scale_id, brand_id: style.brand_id, gender_code: style.gender_code },
    sizes: outSizes,
    colors: outColors,
    inseams,
    rises,
    warehouses,
    lots,
    // Additive: present only when explodePpk was requested. UI folds
    // explode.cells into the matrix and shows the indicator/unmatched note.
    explode: explode ? {
      enabled: true,
      cells: explode.cells,                 // [{ color, size, qty, by_wh:{wh:qty} }]
      packs_exploded: explode.packsExploded, // # of PPK SKUs with a matrix
      packs_unmatched: explode.unmatched,    // [{ ppk_style_code, color, pack_token, qty }]
      ppk_styles: explode.ppkStyles,         // distinct PPK sibling style_codes found
    } : (explodePpk ? { enabled: true, cells: [], packs_exploded: 0, packs_unmatched: [], ppk_styles: [] } : undefined),
    // Additive: present only for PPK (pack-grain) styles. Order entry renders a
    // single pack-count column + the per-size breakdown (explode) from this block.
    prepack: prepack || undefined,
    skus: mergeSkusByCell(skus, { onHand, onHandByWh, avail, lastReceived, avgCostCentsBySku, avgCostCentsByLoose }),
  };
}

// Collapse SKUs that share a (color, normalized-size, inseam) cell into ONE
// entry for the matrix view. The catalog has many duplicate SKUs — straight
// dups (two "SML" rows) and split letter forms ("L" + "LRG") — that would
// otherwise render twice or hide each other's on-hand (consumers match a cell
// with `.find`, so only the first dup's stock would show). We sum on-hand /
// available / per-warehouse, take the latest received, a representative avg
// cost, and keep ONE primary SKU id per cell — preferring the dup that actually
// carries on-hand so the SO resolves against the stocked row. Size is the
// canonical scale label so cells line up with the scale-driven columns.
// Non-destructive: ip_item_master rows are untouched.
function mergeSkusByCell(skus, maps) {
  const { onHand, onHandByWh, avail, lastReceived, avgCostCentsBySku, avgCostCentsByLoose } = maps;
  const cells = new Map(); // `${color}|${size}|${inseam}` → merged sku (+ _primaryOnHand)
  for (const s of skus) {
    const size = normalizeSize(s.size);
    // Canonical color so spelling/case variants of one physical color merge into
    // ONE cell (their on-hand sums) and render under one row. The kept primary
    // `id` is still a real SKU id, so SO/PO/AR saves resolve to the existing row.
    const color = canonColor(s.color);
    const key = `${color ?? ""}|${size ?? ""}|${s.inseam ?? ""}`;
    const oh = onHand.get(s.id) || 0;
    const av = avail.has(s.id) ? avail.get(s.id) : null;
    // Exact sku_code match first; fall back to the loose key so multi-word-color
    // SKUs (master "NAVY-CAMO" vs costing "NAVYCAMO") still resolve their cost.
    let avgC = null;
    if (s.sku_code) {
      if (avgCostCentsBySku.has(s.sku_code)) avgC = avgCostCentsBySku.get(s.sku_code);
      else if (avgCostCentsByLoose) {
        const lk = looseKey(s.sku_code);
        if (avgCostCentsByLoose.has(lk)) avgC = avgCostCentsByLoose.get(lk);
      }
    }
    const lr = lastReceived.has(s.id) ? lastReceived.get(s.id) : null;
    let cell = cells.get(key);
    if (!cell) {
      cell = { ...s, color, size, on_hand_qty: 0, on_hand_by_wh: {}, available_qty: null, avg_cost_cents: null, last_received: null, _primaryOnHand: -1 };
      cells.set(key, cell);
    }
    // Primary (id + sku-level attrs) = the dup with the most on-hand; first wins ties.
    if (oh > cell._primaryOnHand) {
      cell._primaryOnHand = oh;
      cell.id = s.id; cell.sku_code = s.sku_code; cell.length = s.length; cell.fit = s.fit; cell.rise = s.rise;
    }
    cell.on_hand_qty += oh;
    for (const [wh, q] of Object.entries(onHandByWh.get(s.id) || {})) cell.on_hand_by_wh[wh] = (cell.on_hand_by_wh[wh] || 0) + q;
    if (av != null) cell.available_qty = (cell.available_qty || 0) + av;
    if (avgC != null && cell.avg_cost_cents == null) cell.avg_cost_cents = avgC;
    if (lr && (!cell.last_received || lr > cell.last_received)) cell.last_received = lr;
  }
  return [...cells.values()].map(({ _primaryOnHand, ...rest }) => rest);
}

/**
 * SELF-explode a PPK style: convert its OWN pack on-hand into sized eaches using
 * its own prepack_matrices composition. Returns { sizes, colors, skus,
 * packsExploded, unmatched } where skus are synthetic SIZED rows (size = garment
 * size, on_hand_qty = packs × qty_per_pack, avg_cost = pack cost ÷ units/pack),
 * or null when the style has no active matrix or no pack on-hand (caller then
 * renders the normal pack-token grid).
 */
async function computeSelfPpkExplode(admin, entityId, style, packSkus, maps) {
  const { onHand, onHandByWh, lastReceived, avgCostCentsBySku, avgCostCentsByLoose } = maps;

  // This PPK style's own matrix (case-insensitive on ppk_style_code).
  const { data: matrices } = await admin
    .from("prepack_matrices")
    .select("id, ppk_style_code")
    .eq("entity_id", entityId)
    .eq("is_active", true)
    .not("ppk_style_code", "is", null);
  const mine = (matrices || []).find(
    (m) => String(m.ppk_style_code).toLowerCase() === String(style.style_code).toLowerCase(),
  );
  if (!mine) return null;

  const { data: comp } = await admin
    .from("prepack_matrix_sizes")
    .select("size, qty_per_pack")
    .eq("matrix_id", mine.id);
  const composition = (comp || [])
    .map((r) => ({ size: normalizeSize(String(r.size)), qty: Number(r.qty_per_pack) || 0 }))
    .filter((r) => r.size && r.qty > 0);
  if (composition.length === 0) return null;
  const unitsPerPack = composition.reduce((s, r) => s + r.qty, 0);

  // Accumulate exploded eaches per (color, garment-size).
  const cellMap = new Map(); // `${color}|${size}` → cell
  const colorsSeen = [];
  let packsExploded = 0;
  for (const ps of packSkus) {
    const packs = onHand.get(ps.id) || 0;
    if (!(packs > 0)) continue;
    packsExploded += 1;
    const color = canonColor(ps.color) || "—";
    if (!colorsSeen.includes(color)) colorsSeen.push(color);
    const byWh = onHandByWh.get(ps.id) || {};
    // Per-each cost = pack cost ÷ units per pack.
    let packCents = null;
    if (ps.sku_code) {
      if (avgCostCentsBySku.has(ps.sku_code)) packCents = avgCostCentsBySku.get(ps.sku_code);
      else { const lk = looseKey(ps.sku_code); if (avgCostCentsByLoose.has(lk)) packCents = avgCostCentsByLoose.get(lk); }
    }
    const eachCents = packCents != null && unitsPerPack > 0 ? Math.round(packCents / unitsPerPack) : null;
    const lr = lastReceived.get(ps.id) || null;
    for (const { size, qty } of composition) {
      const key = `${color}|${size}`;
      let cell = cellMap.get(key);
      if (!cell) { cell = { color, size, on_hand_qty: 0, on_hand_by_wh: {}, avg_cost_cents: null, last_received: null }; cellMap.set(key, cell); }
      cell.on_hand_qty += packs * qty;
      for (const [wh, p] of Object.entries(byWh)) cell.on_hand_by_wh[wh] = (cell.on_hand_by_wh[wh] || 0) + p * qty;
      if (eachCents != null && cell.avg_cost_cents == null) cell.avg_cost_cents = eachCents;
      if (lr && (!cell.last_received || lr > cell.last_received)) cell.last_received = lr;
    }
  }
  if (packsExploded === 0) return null; // no packs on hand → show the normal grid

  const skus = [...cellMap.values()].map((c) => ({
    id: `selfexp-${c.color}-${c.size}`,
    sku_code: null,
    color: c.color,
    size: c.size,
    inseam: null, length: null, fit: null, rise: null,
    on_hand_qty: c.on_hand_qty,
    on_hand_by_wh: c.on_hand_by_wh,
    available_qty: null,
    avg_cost_cents: c.avg_cost_cents,
    last_received: c.last_received,
  }));
  const sizes = [];
  for (const { size } of composition) if (!sizes.includes(size)) sizes.push(size);
  return { sizes, colors: colorsSeen, skus, packsExploded, unmatched: [] };
}

/**
 * Pick the prepack matrix for a PPK style, tolerant of the inseam-infix mis-keying
 * in the master. The matrix can be keyed with an inseam baked into the code
 * (e.g. `RYB059430PPK`) while the real style — in style_master + ip_item_master —
 * is the style-grain `RYB0594PPK` (the `30` is an inseam present only on the matrix
 * code; it exists nowhere in the catalog). Exact match is preferred; the tolerant
 * fall-back matches when one PPK stem is a prefix of the other and the extra is a
 * short digit run (the inseam).
 *
 * @param {string} styleCode        the PPK style being ordered (e.g. "RYB0594PPK")
 * @param {string|null} skuPackToken the style's real pack token from its SKUs ("PPK24")
 * @param {Array<{id,ppk_style_code,pack_token}>} matrices  active matrices
 * @returns the chosen matrix row or null. Tie-break: same pack token first, then the
 *   shortest (closest) inseam gap, then ppk_style_code order (deterministic).
 */
export function matchPrepackMatrix(styleCode, skuPackToken, matrices) {
  const all = Array.isArray(matrices) ? matrices.filter((m) => m && m.ppk_style_code) : [];
  if (all.length === 0) return null;
  const lc = String(styleCode ?? "").toLowerCase();
  const exact = all.find((m) => String(m.ppk_style_code).toLowerCase() === lc);
  if (exact) return exact;
  const myStem = ppkStem(styleCode); // strips trailing -?PPK\d* → "RYB0594PPK" → "RYB0594"
  if (!myStem) return null;
  const tok = skuPackToken ? String(skuPackToken).toLowerCase() : null;
  const scored = [];
  for (const m of all) {
    const ms = ppkStem(m.ppk_style_code); // "RYB059430PPK" → "RYB059430"
    if (!ms) continue;
    let extra = null;
    if (ms === myStem) extra = "";
    else if (ms.startsWith(myStem)) extra = ms.slice(myStem.length);
    else if (myStem.startsWith(ms)) extra = myStem.slice(ms.length);
    if (extra == null || !/^\d{0,3}$/.test(extra)) continue; // only a short numeric (inseam) gap
    scored.push({ m, extra });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) =>
    (Number(String(b.m.pack_token ?? "").toLowerCase() === tok) - Number(String(a.m.pack_token ?? "").toLowerCase() === tok))
    || (a.extra.length - b.extra.length)
    || String(a.m.ppk_style_code).localeCompare(String(b.m.ppk_style_code)));
  return scored[0].m;
}

/**
 * Build the order-entry PREPACK block for a PPK (pack-grain) style: the single
 * pack token used as the entry column + the per-size composition (from the active
 * prepack_matrices master) so the UI can explode "N packs" into per-size eaches.
 * Returns { pack_token, pack_total, composition:[{size, qty_per_pack}], has_matrix }.
 * `composition` is [] (has_matrix=false) when no active matrix is defined — the
 * UI then still lets the operator enter packs but prompts to define a matrix.
 */
async function computePrepackBlock(admin, entityId, style, skus) {
  const { data: matrices } = await admin
    .from("prepack_matrices")
    .select("id, ppk_style_code, pack_token")
    .eq("entity_id", entityId)
    .eq("is_active", true)
    .not("ppk_style_code", "is", null);
  // The style's real pack token (from its SKUs) — used both to resolve the right
  // matrix and as the entry column so resolve-sku reuses the existing pack SKU.
  const skuPackToken = skus.find((s) => /PPK/i.test(String(s.size ?? "")))?.size || null;
  // Match tolerant of the inseam-infix mis-keying (RYB0594PPK ↔ RYB059430PPK).
  const mine = matchPrepackMatrix(style.style_code, skuPackToken, matrices || []);
  let composition = [];
  if (mine) {
    const { data: comp } = await admin
      .from("prepack_matrix_sizes")
      .select("size, qty_per_pack, inner_pack_qty, sort_order")
      .eq("matrix_id", mine.id)
      .order("sort_order", { ascending: true });
    composition = (comp || [])
      .map((r) => ({ size: normalizeSize(String(r.size)), qty_per_pack: Number(r.qty_per_pack) || 0, inner_pack_qty: Number(r.inner_pack_qty) || 0 }))
      .filter((r) => r.size && r.qty_per_pack > 0);
  }
  // Entry column token: prefer the REAL pack SKU's size (so resolve-sku reuses
  // the existing pack SKU instead of forking a new one), then the matrix token,
  // then a digit-bearing PPK token parsed from the style_code, else "PACK".
  const fromCode = String(style.style_code).match(/PPK\s*\d+/i);
  const pack_token = (skuPackToken && String(skuPackToken).trim())
    || (mine?.pack_token && String(mine.pack_token).trim())
    || (fromCode ? fromCode[0].toUpperCase().replace(/\s+/g, "") : "PACK");
  const compTotal = composition.reduce((a, r) => a + r.qty_per_pack, 0);
  const tokDigits = String(pack_token).match(/(\d+)/);
  const pack_total = compTotal > 0 ? compTotal : (tokDigits ? Number(tokDigits[1]) : null);
  return { pack_token, pack_total, composition, has_matrix: composition.length > 0 };
}

/**
 * Compute the exploded per-size eaches contributed by a SIZED style's PPK
 * sibling packs. Returns { cells, packsExploded, unmatched, ppkStyles,
 * extraSizes, extraColors } and mutates `whSeenAll` to register any new
 * warehouses the PPK layers introduce (so the matrix warehouse filter shows
 * them). Packs whose PPK style_code has no matrix in prepack_matrices are
 * reported in `unmatched` and NOT exploded.
 */
async function computePpkExplode(admin, entityId, style, whSeenAll, lotFilter = null, lotsSeen = null) {
  const stem = ppkStem(style.style_code);
  const empty = { cells: [], packsExploded: 0, unmatched: [], ppkStyles: [], extraSizes: [], extraColors: [] };
  if (!stem) return empty;

  // PPK sibling SKUs: same stem, style_code contains PPK. We can't ILIKE on a
  // computed stem, so fetch PPK-token SKUs whose style_code starts with the stem
  // and filter precisely in JS (handles "RYB059430PPK", "RJO0639-PPK").
  const { data: cand } = await admin
    .from("ip_item_master")
    .select("id, sku_code, style_code, color, size")
    .eq("entity_id", entityId)
    .ilike("style_code", `${stem}%`);
  const ppkSkus = (cand || []).filter(
    (r) => isPpkStyle(r.style_code) && ppkStem(r.style_code) === stem,
  );
  if (ppkSkus.length === 0) return empty;

  // Pack on-hand per PPK SKU, broken down by warehouse. Prefer the layer's
  // location_id (authoritative since the multi-warehouse cutover); fall back to
  // the legacy `wh=` notes tag for any layer without a location_id.
  const ppkIds = ppkSkus.map((s) => s.id);
  const locNameById = new Map();
  {
    const { data: locRows } = await admin
      .from("inventory_locations")
      .select("id, name")
      .eq("entity_id", entityId);
    for (const lr of locRows || []) locNameById.set(lr.id, lr.name);
  }
  const packOnHand = new Map();    // ppk item_id → { total, byWh:{wh:qty} }
  {
    const { data: layers } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty, notes, location_id, lot_number")
      .in("item_id", ppkIds);
    for (const l of layers || []) {
      const q = Number(l.remaining_qty);
      if (!(q > 0)) continue;
      const lot = lotKeyOf(l.lot_number);
      if (lotsSeen) lotsSeen.add(lot);              // sibling pack lots feed the full list
      if (lotFilter && !lotFilter.has(lot)) continue;
      let rec = packOnHand.get(l.item_id);
      if (!rec) { rec = { total: 0, byWh: {} }; packOnHand.set(l.item_id, rec); }
      rec.total += q;
      const locName = l.location_id ? locNameById.get(l.location_id) : null;
      const m = (l.notes || "").match(/wh=(.+)$/);
      const wh = locName || (m ? m[1].trim() : WH_UNASSIGNED);
      rec.byWh[wh] = (rec.byWh[wh] || 0) + q;
    }
  }

  // Look up matrices for the distinct PPK sibling style_codes. The master keys
  // on ppk_style_code (case-insensitive); fetch all then index by lowercased.
  const ppkStyleCodes = [...new Set(ppkSkus.map((s) => s.style_code).filter(Boolean))];
  const matrixByStyle = new Map(); // lower(ppk_style_code) → [{size, qty_per_pack}]
  if (ppkStyleCodes.length > 0) {
    const { data: matrices } = await admin
      .from("prepack_matrices")
      .select("id, ppk_style_code, is_active")
      .eq("entity_id", entityId)
      .eq("is_active", true)
      .not("ppk_style_code", "is", null);
    const wanted = new Set(ppkStyleCodes.map((c) => c.toLowerCase()));
    const matchIds = (matrices || []).filter((m) => wanted.has(String(m.ppk_style_code).toLowerCase()));
    if (matchIds.length > 0) {
      const { data: comp } = await admin
        .from("prepack_matrix_sizes")
        .select("matrix_id, size, qty_per_pack")
        .in("matrix_id", matchIds.map((m) => m.id));
      const compByMatrix = new Map();
      for (const r of comp || []) {
        const arr = compByMatrix.get(r.matrix_id) || [];
        arr.push({ size: String(r.size), qty_per_pack: Number(r.qty_per_pack) || 0 });
        compByMatrix.set(r.matrix_id, arr);
      }
      for (const m of matchIds) {
        matrixByStyle.set(String(m.ppk_style_code).toLowerCase(), compByMatrix.get(m.id) || []);
      }
    }
  }

  // Explode each PPK SKU's packs by its matrix composition.
  const cellMap = new Map(); // `${color}|${size}` → { color, size, qty, by_wh:{} }
  const unmatched = [];
  const extraSizes = new Set();
  const extraColors = new Set();
  let packsExploded = 0;

  for (const ppk of ppkSkus) {
    const oh = packOnHand.get(ppk.id);
    if (!oh || oh.total <= 0) continue; // no packs on hand → nothing to explode
    const comp = matrixByStyle.get(String(ppk.style_code).toLowerCase());
    if (!comp || comp.length === 0) {
      unmatched.push({ ppk_style_code: ppk.style_code, color: ppk.color || null, pack_token: ppk.size || null, qty: oh.total });
      continue;
    }
    packsExploded += 1;
    const color = canonColor(ppk.color) || "—";
    extraColors.add(color);
    for (const { size: rawSize, qty_per_pack } of comp) {
      const size = normalizeSize(rawSize); // align pack sizes with the canonical grid columns
      if (!size || !(qty_per_pack > 0)) continue;
      extraSizes.add(size);
      const key = `${color}|${size}`;
      let cell = cellMap.get(key);
      if (!cell) { cell = { color, size, qty: 0, by_wh: {} }; cellMap.set(key, cell); }
      cell.qty += oh.total * qty_per_pack;
      for (const [wh, packs] of Object.entries(oh.byWh)) {
        whSeenAll.add(wh);
        cell.by_wh[wh] = (cell.by_wh[wh] || 0) + packs * qty_per_pack;
      }
    }
  }

  return {
    cells: [...cellMap.values()],
    packsExploded,
    unmatched,
    ppkStyles: ppkStyleCodes,
    extraSizes: [...extraSizes],
    extraColors: [...extraColors],
  };
}

/** Find (or create) the ip_item_master SKU for one matrix cell. */
export async function resolveOrCreateSku(admin, entityId, { style_id, style_code, color, size, inseam }, opts = {}) {
  if (!style_id || !size) return { error: "style_id and size required" };
  const isApparel = opts.isApparel !== false; // default true; ingest passes false
  // Store the CANONICAL color so a new SKU doesn't fork a spelling variant of an
  // existing physical color (see canonColor). findExistingId() below also matches
  // canonically, so an entry for "Skyfall Light Wash" reuses a legacy raw
  // "SKYFALL - Lt Wash" row rather than creating a third.
  const colorVal = color ? canonColor(String(color).trim()) : null;
  const canonSize = String(normalizeSize(String(size).trim()));   // store + create canonical
  let inseamVal = inseam ? String(inseam).trim() : null;

  // Inherit the apparel dims (inseam / length / fit) from an existing sibling SKU
  // of this style (same colour preferred) so a NEW size variant of an apparel
  // bottom satisfies the apparel_dims_required CHECK. The matrix only carries
  // colour/size (+ optional inseam), so without this the insert would fail with
  // "violates check constraint apparel_dims_required". Inheriting the inseam also
  // keeps find/create consistent (no null-inseam duplicate of an inseam SKU).
  let lengthVal = null, fitVal = null, siblingApparel = null;
  {
    let tq = admin.from("ip_item_master").select("inseam, length, fit, is_apparel").eq("entity_id", entityId).eq("style_id", style_id);
    if (colorVal) tq = tq.eq("color", colorVal);
    let { data: trows } = await tq.limit(5);
    if ((!trows || !trows.length) && colorVal) {
      ({ data: trows } = await admin.from("ip_item_master").select("inseam, length, fit, is_apparel").eq("entity_id", entityId).eq("style_id", style_id).limit(5));
    }
    const tmpl = (trows || []).find((r) => r.inseam || r.length || r.fit) || (trows || [])[0] || null;
    if (tmpl) {
      if (!inseamVal && tmpl.inseam) inseamVal = String(tmpl.inseam).trim();
      lengthVal = tmpl.length ? String(tmpl.length).trim() : null;
      fitVal = tmpl.fit ? String(tmpl.fit).trim() : null;
      siblingApparel = tmpl.is_apparel;
    }
  }

  // Find existing — match ANY stored spelling of this size (SML/S/SMALL all
  // resolve to the same row) so we REUSE rather than fork a duplicate. Tolerate
  // multiple legacy dups: pick deterministically (prefer the canonical spelling,
  // then oldest) instead of erroring — the old `.maybeSingle()` threw on 2+ rows
  // and the caller then created a THIRD, which is how the catalog fragmented.
  // Reused on a 23505 below so a race / the logical-tuple UNIQUE index
  // (uq_ip_item_master_logical_sku) resolves to the existing row, not an error.
  async function findExistingId() {
    // Match by size-variant + inseam in the query, then filter to the CANONICAL
    // color in JS (can't canonColor inside a PostgREST filter) so a canonical
    // colorVal reuses whatever raw spelling the row was stored with. `colorVal`
    // is already canonical (or null); compare against canonColor(row.color).
    const q = admin.from("ip_item_master").select("id, color, size, inseam, created_at").eq("entity_id", entityId).eq("style_id", style_id).in("size", sizeVariantsOf(size));
    const { data: rows, error: e } = await q;
    if (e || !rows || !rows.length) return null;
    const wantInseam = inseamVal || null;
    const matches = rows.filter((r) =>
      ((canonColor(r.color) ?? null) === (colorVal ?? null)) &&
      (((r.inseam ? String(r.inseam).trim() : null) || null) === wantInseam));
    if (!matches.length) return null;
    return matches.slice().sort((a, b) =>
      (normalizeSize(b.size) === b.size) - (normalizeSize(a.size) === a.size) // exact-canonical first
      || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0].id;
  }
  const existingId = await findExistingId();
  if (existingId) return { id: existingId, created: false };

  // style_code for the new SKU. ALWAYS prefer the CANONICAL code from style_master
  // (by style_id) over the caller's string — a REST/import feed can hand us a
  // mis-cased BasePartNumber (e.g. "rbb0185" vs the catalog "RBB0185"), and
  // inheriting it strands the SKU from its style (style_master matches are
  // case-sensitive) → the size matrix can't resolve it ("Style rbb0185 not
  // found"). style_id is authoritative, so the master's casing wins. Fallback
  // (no style_id) uppercases the supplied code to keep style codes canonical.
  let sc = style_code || null;
  if (style_id) {
    const { data: st } = await admin.from("style_master").select("style_code").eq("id", style_id).maybeSingle();
    if (st?.style_code) sc = st.style_code;
  }
  if (sc && !style_id) sc = String(sc).trim().toUpperCase();

  const base = [SKU_SAFE(sc), SKU_SAFE(colorVal), SKU_SAFE(canonSize), inseamVal ? SKU_SAFE(inseamVal) : ""].filter(Boolean).join("-");
  // sku_code is globally UNIQUE — retry with a numeric suffix on collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const skuCode = attempt === 0 ? base : `${base}-${attempt}`;
    // Flag is_apparel only when all five matrix dims are present (the CHECK
    // requires it); otherwise create a non-apparel partial SKU so the save
    // succeeds — it surfaces in the merchandiser-review list to be completed.
    // NB: coerce to a real boolean with !!. `(isApparel || siblingApparel)`
    // returns null when isApparel===false and siblingApparel===null (JS `||`
    // yields the last falsy operand), and `null && …` stays null → a NOT-NULL
    // violation on is_apparel. This bit the size-onhand ingest (isApparel:false)
    // for styles with no dim-carrying sibling. !! makes null→false (the intended
    // non-apparel value) without changing any valid true/false result.
    const apparelFinal = !!((isApparel || siblingApparel) && !!colorVal && !!canonSize && !!inseamVal && !!lengthVal && !!fitVal);
    const { data: created, error } = await admin
      .from("ip_item_master")
      .insert({ entity_id: entityId, sku_code: skuCode, style_code: sc, style_id, color: colorVal, size: canonSize, inseam: inseamVal, length: lengthVal, fit: fitVal, is_apparel: apparelFinal })
      .select("id")
      .single();
    if (!error && created) return { id: created.id, created: true };
    if (error && error.code !== "23505") return { error: error.message };
    // 23505 → either the logical-tuple UNIQUE index (a variant/race row for the
    // same (style,color,canonical-size,inseam) landed) or the sku_code unique (a
    // DIFFERENT tuple grabbed this sku_code). Re-find by the tuple first and
    // reuse; else by the exact sku_code; else bump the suffix and retry.
    const viaTuple = await findExistingId();
    if (viaTuple) return { id: viaTuple, created: false };
    const { data: again } = await admin.from("ip_item_master").select("id").eq("entity_id", entityId).eq("sku_code", skuCode).maybeSingle();
    if (again?.id) return { id: again.id, created: false };
  }
  return { error: "could not allocate a unique sku_code" };
}
