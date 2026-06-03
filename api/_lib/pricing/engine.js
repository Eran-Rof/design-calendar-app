// api/_lib/pricing/engine.js
//
// M43 — THE single price-resolution engine. Server-side only; one implementation
// shared by the B2B portal (catalog + order create, via api/_lib/b2b/pricing.js),
// internal SO/AR auto-fill, and the resolve endpoint. Prices are NEVER taken from
// client input.
//
// Resolution for (customer, style, qty, date) — first list in precedence order
// that prices the style wins; then the best promotion is applied:
//   1. customer's OWN list      price_lists.customer_id = customer
//   2. customer's ASSIGNED list customers.price_list_id
//   3. TIER list                price_lists.customer_tier = customers.customer_tier
//   4. DEFAULT list             price_lists.is_default
// Within a list: the highest min_qty <= qty among active, in-effect items (qty
// break). Then the single best (largest-discount) active, in-effect, matching
// promotion (no stacking in v1).
//
// resolvePrice(admin, {customerId, styleId, qty, date}) → one style.
// resolvePricesForCustomer(admin, customerId, styleIds, qty?, date?) → Map (batch).
//   Both return entries shaped:
//   { price_cents, currency, base_price_cents, min_qty, source_list_id,
//     source_list_code, applied_promotion_id }  (null when no price found).

function today() { return new Date().toISOString().slice(0, 10); }
const inEffect = (row, d) =>
  row.is_active !== false &&
  !(row.effective_from && String(row.effective_from) > d) &&
  !(row.effective_to && String(row.effective_to) < d);

// Best qty-break item for a style within ONE list: highest min_qty <= qty, in effect.
function bestBreak(items, qty, d) {
  let best = null;
  for (const it of items) {
    if (!inEffect(it, d)) continue;
    if (Number(it.min_qty || 0) > qty) continue;
    if (!best || Number(it.min_qty || 0) > Number(best.min_qty || 0)) best = it;
  }
  return best;
}

// Apply the single best matching promotion to a base price for one style.
function applyBestPromo(promos, { styleId, brandId, customerId, tier, qty }, baseCents, d) {
  let bestCents = baseCents, bestId = null;
  for (const p of promos) {
    if (!inEffect(p, d)) continue;
    if (Number(p.min_qty || 0) > qty) continue;
    if (p.style_id && p.style_id !== styleId) continue;
    if (p.brand_id && p.brand_id !== brandId) continue;
    if (p.customer_id && p.customer_id !== customerId) continue;
    if (p.customer_tier && p.customer_tier !== tier) continue;
    const v = Number(p.discount_value) || 0;
    const out = p.discount_type === "percent"
      ? Math.max(0, Math.round(baseCents * (1 - v / 100)))
      : Math.max(0, baseCents - Math.round(v));
    if (out < bestCents) { bestCents = out; bestId = p.id; }
  }
  return { cents: bestCents, promoId: bestId };
}

// Load the customer context + the ordered candidate list IDs for resolution.
async function loadContext(admin, customerId) {
  let entityId = null, tier = null, assignedListId = null;
  if (customerId) {
    const { data: c } = await admin.from("customers").select("entity_id, customer_tier, price_list_id").eq("id", customerId).maybeSingle();
    if (c) { entityId = c.entity_id; tier = c.customer_tier || null; assignedListId = c.price_list_id || null; }
  }
  if (!entityId) {
    const { data: e } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    entityId = e?.id || null;
  }
  // All active lists for the entity (small set); rank in precedence order.
  const { data: lists } = await admin.from("price_lists")
    .select("id, code, currency, customer_id, customer_tier, is_default")
    .eq("entity_id", entityId).eq("is_active", true);
  const ordered = [];
  const push = (l) => { if (l && !ordered.find((x) => x.id === l.id)) ordered.push(l); };
  push((lists || []).find((l) => customerId && l.customer_id === customerId));   // 1 own
  push((lists || []).find((l) => assignedListId && l.id === assignedListId));    // 2 assigned
  push((lists || []).find((l) => tier && !l.customer_id && l.customer_tier === tier)); // 3 tier
  push((lists || []).find((l) => l.is_default));                                 // 4 default
  return { entityId, tier, orderedLists: ordered };
}

// Core batch resolver. styleIds → Map<style_id, entry|null-absent>.
export async function resolvePricesForCustomer(admin, customerId, styleIds, qty = 1, date) {
  const out = new Map();
  if (!styleIds || styleIds.length === 0) return out;
  const d = date || today();
  const { entityId, tier, orderedLists } = await loadContext(admin, customerId);
  if (orderedLists.length === 0) return out;
  const listIds = orderedLists.map((l) => l.id);

  // Items across all candidate lists for these styles.
  const { data: items } = await admin.from("price_list_items")
    .select("price_list_id, style_id, price_cents, min_qty, effective_from, effective_to, is_active")
    .in("price_list_id", listIds).in("style_id", styleIds);
  // index: listId -> styleId -> [items]
  const byList = new Map();
  for (const it of items || []) {
    if (!byList.has(it.price_list_id)) byList.set(it.price_list_id, new Map());
    const m = byList.get(it.price_list_id);
    if (!m.has(it.style_id)) m.set(it.style_id, []);
    m.get(it.style_id).push(it);
  }

  // Style brands (for brand-scoped promos).
  const { data: styles } = await admin.from("style_master").select("id, brand_id").in("id", styleIds);
  const brandOf = new Map((styles || []).map((s) => [s.id, s.brand_id]));

  // Active promotions for the entity (small set; filtered per style in JS).
  const { data: promos } = await admin.from("price_promotions")
    .select("id, code, discount_type, discount_value, style_id, brand_id, customer_id, customer_tier, min_qty, effective_from, effective_to, is_active")
    .eq("entity_id", entityId).eq("is_active", true);

  for (const sid of styleIds) {
    let chosen = null, chosenList = null;
    for (const l of orderedLists) {
      const items2 = byList.get(l.id)?.get(sid);
      const b = items2 && bestBreak(items2, qty, d);
      if (b) { chosen = b; chosenList = l; break; }
    }
    if (!chosen) continue;
    const base = Number(chosen.price_cents);
    const { cents, promoId } = applyBestPromo(promos || [], { styleId: sid, brandId: brandOf.get(sid), customerId, tier, qty }, base, d);
    out.set(sid, {
      price_cents: cents,
      base_price_cents: base,
      currency: chosenList.currency || "USD",
      min_qty: Number(chosen.min_qty) || 0,
      source_list_id: chosenList.id,
      source_list_code: chosenList.code,
      applied_promotion_id: promoId,
    });
  }
  return out;
}

// Single-style convenience wrapper.
export async function resolvePrice(admin, { customerId, styleId, qty = 1, date } = {}) {
  if (!styleId) return null;
  const m = await resolvePricesForCustomer(admin, customerId || null, [styleId], qty, date);
  return m.get(styleId) || null;
}
