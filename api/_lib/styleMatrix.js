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

/** Build the matrix payload for one style. */
export async function enumerateStyleMatrix(admin, entityId, styleId) {
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
    for (const s of skus) { if (s.size && !seen.has(s.size)) { seen.add(s.size); sizes.push(s.size); } }
  }
  const colors = [...new Set(skus.map((s) => s.color).filter(Boolean))];
  const inseams = [...new Set(skus.map((s) => s.inseam).filter(Boolean))];
  const rises = [...new Set(skus.map((s) => s.rise).filter(Boolean))];

  // On-hand (Σ remaining_qty) + available (M18 view) + last-received per item.
  const ids = skus.map((s) => s.id);
  const onHand = new Map();
  const avail = new Map();
  const lastReceived = new Map();
  if (ids.length > 0) {
    const { data: layers } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty, received_at")
      .in("item_id", ids);
    for (const l of layers || []) {
      if (Number(l.remaining_qty) > 0) onHand.set(l.item_id, (onHand.get(l.item_id) || 0) + Number(l.remaining_qty));
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

  return {
    style: { id: style.id, style_code: style.style_code, style_name: style.style_name, description: style.description, size_scale_id: style.size_scale_id, brand_id: style.brand_id, gender_code: style.gender_code },
    sizes,
    colors,
    inseams,
    rises,
    skus: skus.map((s) => ({
      ...s,
      on_hand_qty: onHand.get(s.id) || 0,
      available_qty: avail.has(s.id) ? avail.get(s.id) : null,
      avg_cost_cents: s.sku_code && avgCostCentsBySku.has(s.sku_code) ? avgCostCentsBySku.get(s.sku_code) : null,
      last_received: lastReceived.has(s.id) ? lastReceived.get(s.id) : null,
    })),
  };
}

/** Find (or create) the ip_item_master SKU for one matrix cell. */
export async function resolveOrCreateSku(admin, entityId, { style_id, style_code, color, size, inseam }) {
  if (!style_id || !size) return { error: "style_id and size required" };
  const colorVal = color ? String(color).trim() : null;
  const sizeVal = String(size).trim();
  const inseamVal = inseam ? String(inseam).trim() : null;

  // Find existing (style, color, size, inseam).
  let q = admin.from("ip_item_master").select("id").eq("entity_id", entityId).eq("style_id", style_id).eq("size", sizeVal);
  q = colorVal ? q.eq("color", colorVal) : q.is("color", null);
  q = inseamVal ? q.eq("inseam", inseamVal) : q.is("inseam", null);
  const { data: existing } = await q.maybeSingle();
  if (existing?.id) return { id: existing.id, created: false };

  // Need the style_code if not supplied.
  let sc = style_code;
  if (!sc) {
    const { data: st } = await admin.from("style_master").select("style_code").eq("id", style_id).maybeSingle();
    sc = st?.style_code || null;
  }

  const base = [SKU_SAFE(sc), SKU_SAFE(colorVal), SKU_SAFE(sizeVal), inseamVal ? SKU_SAFE(inseamVal) : ""].filter(Boolean).join("-");
  // sku_code is globally UNIQUE — retry with a numeric suffix on collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const skuCode = attempt === 0 ? base : `${base}-${attempt}`;
    const { data: created, error } = await admin
      .from("ip_item_master")
      .insert({ entity_id: entityId, sku_code: skuCode, style_code: sc, style_id, color: colorVal, size: sizeVal, inseam: inseamVal, is_apparel: true })
      .select("id")
      .single();
    if (!error && created) return { id: created.id, created: true };
    if (error && error.code !== "23505") return { error: error.message };
    // 23505 → sku_code collided; if it's the same combo that raced in, re-find.
    const { data: again } = await admin.from("ip_item_master").select("id").eq("entity_id", entityId).eq("style_id", style_id).eq("size", sizeVal).eq("sku_code", skuCode).maybeSingle();
    if (again?.id) return { id: again.id, created: false };
  }
  return { error: "could not allocate a unique sku_code" };
}
