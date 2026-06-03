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
    .select("id, style_code, style_name, description, size_scale_id, brand_id, gender_code")
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
  const colors = [...new Set(skus.map((s) => s.color).filter(Boolean))];
  const inseams = [...new Set(skus.map((s) => s.inseam).filter(Boolean))];
  const rises = [...new Set(skus.map((s) => s.rise).filter(Boolean))];

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
  if (ids.length > 0) {
    const { data: layers } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty, received_at, notes")
      .in("item_id", ids);
    for (const l of layers || []) {
      const q = Number(l.remaining_qty);
      if (q > 0) {
        onHand.set(l.item_id, (onHand.get(l.item_id) || 0) + q);
        const m = (l.notes || "").match(/wh=(.+)$/);
        const wh = m ? m[1].trim() : WH_UNASSIGNED;
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
  const avgCostCentsBySku = new Map();
  const skuCodes = [...new Set(skus.map((s) => s.sku_code).filter(Boolean))];
  if (skuCodes.length > 0) {
    const { data: avgRows, error: avgErr } = await admin
      .from("ip_item_avg_cost")
      .select("sku_code, avg_cost")
      .in("sku_code", skuCodes);
    if (!avgErr) {
      for (const r of avgRows || []) {
        if (r.avg_cost != null) avgCostCentsBySku.set(r.sku_code, Math.round(Number(r.avg_cost) * 100));
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
  let explode = null;
  if (explodePpk && !isPpkStyle(style.style_code)) {
    explode = await computePpkExplode(admin, entityId, style, whSeenAll);
  }

  const warehouses = [...whSeenAll].filter((w) => w !== WH_UNASSIGNED).sort((a, b) => a.localeCompare(b));
  if (whSeenAll.has(WH_UNASSIGNED)) warehouses.push(WH_UNASSIGNED);

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
    skus: mergeSkusByCell(skus, { onHand, onHandByWh, avail, lastReceived, avgCostCentsBySku }),
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
  const { onHand, onHandByWh, avail, lastReceived, avgCostCentsBySku } = maps;
  const cells = new Map(); // `${color}|${size}|${inseam}` → merged sku (+ _primaryOnHand)
  for (const s of skus) {
    const size = normalizeSize(s.size);
    const key = `${s.color ?? ""}|${size ?? ""}|${s.inseam ?? ""}`;
    const oh = onHand.get(s.id) || 0;
    const av = avail.has(s.id) ? avail.get(s.id) : null;
    const avgC = s.sku_code && avgCostCentsBySku.has(s.sku_code) ? avgCostCentsBySku.get(s.sku_code) : null;
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

  // Pack on-hand per PPK SKU, broken down by warehouse (same notes `wh=` parse).
  const ppkIds = ppkSkus.map((s) => s.id);
  const packOnHand = new Map();    // ppk item_id → { total, byWh:{wh:qty} }
  {
    const { data: layers } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty, notes")
      .in("item_id", ppkIds);
    for (const l of layers || []) {
      const q = Number(l.remaining_qty);
      if (!(q > 0)) continue;
      let rec = packOnHand.get(l.item_id);
      if (!rec) { rec = { total: 0, byWh: {} }; packOnHand.set(l.item_id, rec); }
      rec.total += q;
      const m = (l.notes || "").match(/wh=(.+)$/);
      const wh = m ? m[1].trim() : WH_UNASSIGNED;
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
  let q = admin.from("ip_item_master").select("id, size, created_at").eq("entity_id", entityId).eq("style_id", style_id).in("size", sizeVariantsOf(size));
  q = colorVal ? q.eq("color", colorVal) : q.is("color", null);
  q = inseamVal ? q.eq("inseam", inseamVal) : q.is("inseam", null);
  const { data: matches, error: findErr } = await q;
  if (findErr) return { error: findErr.message };
  if (matches && matches.length) {
    const best = matches.slice().sort((a, b) =>
      (normalizeSize(b.size) === b.size) - (normalizeSize(a.size) === a.size) // exact-canonical first
      || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0];
    return { id: best.id, created: false };
  }

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
    // 23505 → sku_code collided; re-find by the colliding sku_code (race) or
    // by the tuple (a variant row landed) and reuse it.
    const { data: again } = await admin.from("ip_item_master").select("id").eq("entity_id", entityId).eq("sku_code", skuCode).maybeSingle();
    if (again?.id) return { id: again.id, created: false };
  }
  return { error: "could not allocate a unique sku_code" };
}
