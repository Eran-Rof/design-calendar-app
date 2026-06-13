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

// Bucket name for inventory layers that carry no `wh=<Store>` token in `notes`
// (color-grain opening_balance layers predate the by-size warehouse cutover).
const WH_UNASSIGNED = "(unassigned)";

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
  }
  let colors = [...new Set(skus.map((s) => s.color).filter(Boolean))];
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
    const declaredNames = declaredColorIds.map((id) => nameById.get(id)).filter(Boolean);
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
      .select("item_id, remaining_qty, received_at, notes, location_id")
      .in("item_id", ids);
    for (const l of layers || []) {
      const q = Number(l.remaining_qty);
      if (q > 0) {
        onHand.set(l.item_id, (onHand.get(l.item_id) || 0) + q);
        const locName = l.location_id ? locNameById.get(l.location_id) : null;
        const m = (l.notes || "").match(/wh=(.+)$/);
        const wh = locName || (m ? m[1].trim() : WH_UNASSIGNED);
        whSeen.add(wh);
        let byWh = onHandByWh.get(l.item_id);
        if (!byWh) { byWh = {}; onHandByWh.set(l.item_id, byWh); }
        byWh[wh] = (byWh[wh] || 0) + q;
      }
      if (l.received_at) {
        const prev = lastReceived.get(l.item_id);
        if (!prev || l.received_at > prev) lastReceived.set(l.item_id, l.received_at);
      }
    }
    const { data: av } = await admin.from("v_inventory_available").select("item_id, available_qty").in("item_id", ids);
    for (const a of av || []) avail.set(a.item_id, Number(a.available_qty));
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
    explode = await computePpkExplode(admin, entityId, style, whSeenAll);
  }

  const warehouses = [...whSeenAll].filter((w) => w !== WH_UNASSIGNED).sort((a, b) => a.localeCompare(b));
  if (whSeenAll.has(WH_UNASSIGNED)) warehouses.push(WH_UNASSIGNED);

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
    // Additive: present only when explodePpk was requested. UI folds
    // explode.cells into the matrix and shows the indicator/unmatched note.
    explode: explode ? {
      enabled: true,
      cells: explode.cells,                 // [{ color, size, qty, by_wh:{wh:qty} }]
      packs_exploded: explode.packsExploded, // # of PPK SKUs with a matrix
      packs_unmatched: explode.unmatched,    // [{ ppk_style_code, color, pack_token, qty }]
      ppk_styles: explode.ppkStyles,         // distinct PPK sibling style_codes found
    } : (explodePpk ? { enabled: true, cells: [], packs_exploded: 0, packs_unmatched: [], ppk_styles: [] } : undefined),
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
    const key = `${s.color ?? ""}|${size ?? ""}|${s.inseam ?? ""}`;
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
      cell = { ...s, size, on_hand_qty: 0, on_hand_by_wh: {}, available_qty: null, avg_cost_cents: null, last_received: null, _primaryOnHand: -1 };
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
    const color = ps.color || "—";
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
 * Compute the exploded per-size eaches contributed by a SIZED style's PPK
 * sibling packs. Returns { cells, packsExploded, unmatched, ppkStyles,
 * extraSizes, extraColors } and mutates `whSeenAll` to register any new
 * warehouses the PPK layers introduce (so the matrix warehouse filter shows
 * them). Packs whose PPK style_code has no matrix in prepack_matrices are
 * reported in `unmatched` and NOT exploded.
 */
async function computePpkExplode(admin, entityId, style, whSeenAll) {
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
      .select("item_id, remaining_qty, notes, location_id")
      .in("item_id", ppkIds);
    for (const l of layers || []) {
      const q = Number(l.remaining_qty);
      if (!(q > 0)) continue;
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
    const color = ppk.color || "—";
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
  const colorVal = color ? String(color).trim() : null;
  const canonSize = String(normalizeSize(String(size).trim()));   // store + create canonical
  const inseamVal = inseam ? String(inseam).trim() : null;

  // Find existing — match ANY stored spelling of this size (SML/S/SMALL all
  // resolve to the same row) so we REUSE rather than fork a duplicate. Tolerate
  // multiple legacy dups: pick deterministically (prefer the canonical spelling,
  // then oldest) instead of erroring — the old `.maybeSingle()` threw on 2+ rows
  // and the caller then created a THIRD, which is how the catalog fragmented.
  // Reused on a 23505 below so a race / the logical-tuple UNIQUE index
  // (uq_ip_item_master_logical_sku) resolves to the existing row, not an error.
  async function findExistingId() {
    let q = admin.from("ip_item_master").select("id, size, created_at").eq("entity_id", entityId).eq("style_id", style_id).in("size", sizeVariantsOf(size));
    q = colorVal ? q.eq("color", colorVal) : q.is("color", null);
    q = inseamVal ? q.eq("inseam", inseamVal) : q.is("inseam", null);
    const { data: rows, error: e } = await q;
    if (e || !rows || !rows.length) return null;
    return rows.slice().sort((a, b) =>
      (normalizeSize(b.size) === b.size) - (normalizeSize(a.size) === a.size) // exact-canonical first
      || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0].id;
  }
  const existingId = await findExistingId();
  if (existingId) return { id: existingId, created: false };

  // Need the style_code if not supplied.
  let sc = style_code;
  if (!sc) {
    const { data: st } = await admin.from("style_master").select("style_code").eq("id", style_id).maybeSingle();
    sc = st?.style_code || null;
  }

  const base = [SKU_SAFE(sc), SKU_SAFE(colorVal), SKU_SAFE(canonSize), inseamVal ? SKU_SAFE(inseamVal) : ""].filter(Boolean).join("-");
  // sku_code is globally UNIQUE — retry with a numeric suffix on collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const skuCode = attempt === 0 ? base : `${base}-${attempt}`;
    const { data: created, error } = await admin
      .from("ip_item_master")
      .insert({ entity_id: entityId, sku_code: skuCode, style_code: sc, style_id, color: colorVal, size: canonSize, inseam: inseamVal, is_apparel: isApparel })
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
