// Provisional style selling prices — seed + maintenance.
//
// For a PO's styles that have NO selling history, seed a placeholder selling
// price at a 21% MARGIN off the PO's own qty-weighted line cost
// (sell = cost / (1 - 0.21)). Stored in the dedicated provisional_style_prices
// table (never read by the M43 quote engine). Styles that DO have selling
// history get any stale provisional row deactivated, since recent_sell_by_style
// resolves their real price for the grid instead.

export const PROVISIONAL_MARGIN_PCT = 21;
const DIVISOR = 1 - PROVISIONAL_MARGIN_PCT / 100; // 0.79

// Compute a provisional sell (cents) from a cost (cents) at the fixed margin.
export function provisionalSellCents(costCents) {
  const c = Number(costCents) || 0;
  if (c <= 0) return null;
  return Math.round(c / DIVISOR);
}

// Seed / refresh provisional prices for one PO. Best-effort: callers should not
// fail the PO operation if this throws. Returns { seeded, deactivated }.
export async function seedProvisionalForPo(admin, poId) {
  const { data: po } = await admin.from("purchase_orders").select("id, entity_id").eq("id", poId).maybeSingle();
  if (!po) return { seeded: 0, deactivated: 0 };

  const { data: lines } = await admin.from("purchase_order_lines")
    .select("inventory_item_id, qty_ordered, unit_cost_cents").eq("purchase_order_id", poId);
  const allLines = lines || [];
  const itemIds = [...new Set(allLines.map((l) => l.inventory_item_id).filter(Boolean))];
  if (!itemIds.length) return { seeded: 0, deactivated: 0 };

  // inventory_item_id → style_id.
  const styleByItem = new Map();
  for (let i = 0; i < itemIds.length; i += 300) {
    const { data: items } = await admin.from("ip_item_master").select("id, style_id").in("id", itemIds.slice(i, i + 300));
    for (const it of items || []) if (it.style_id) styleByItem.set(it.id, it.style_id);
  }

  // Qty-weighted avg PO cost per style.
  const costNum = new Map(), costDen = new Map();
  for (const l of allLines) {
    const sid = l.inventory_item_id ? styleByItem.get(l.inventory_item_id) : null;
    if (!sid) continue;
    const qty = Number(l.qty_ordered) || 0;
    const cost = Number(l.unit_cost_cents) || 0;
    if (qty <= 0 || cost <= 0) continue;
    costNum.set(sid, (costNum.get(sid) || 0) + cost * qty);
    costDen.set(sid, (costDen.get(sid) || 0) + qty);
  }
  const styleIds = [...costDen.keys()];
  if (!styleIds.length) return { seeded: 0, deactivated: 0 };

  // Styles that already have selling history → real price wins; no placeholder.
  const withHistory = new Set();
  const { data: sold } = await admin.rpc("recent_sell_by_style", { p_style_ids: styleIds });
  for (const r of sold || []) withHistory.add(r.style_id);

  // Deactivate any stale provisional for styles that now have history.
  const historyIds = styleIds.filter((s) => withHistory.has(s));
  let deactivated = 0;
  if (historyIds.length) {
    const { data: deact } = await admin.from("provisional_style_prices")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("entity_id", po.entity_id).in("style_id", historyIds).eq("is_active", true).select("id");
    deactivated = (deact || []).length;
  }

  // Upsert provisional rows for no-history styles with a positive cost.
  const rows = [];
  for (const sid of styleIds) {
    if (withHistory.has(sid)) continue;
    const avgCost = Math.round(costNum.get(sid) / costDen.get(sid));
    const sell = provisionalSellCents(avgCost);
    if (sell == null) continue;
    rows.push({
      entity_id: po.entity_id, style_id: sid, price_cents: sell,
      margin_pct: PROVISIONAL_MARGIN_PCT, basis: "po_line_cost", source_po_id: po.id,
      is_active: true, updated_at: new Date().toISOString(),
    });
  }
  let seeded = 0;
  if (rows.length) {
    const { data: up } = await admin.from("provisional_style_prices")
      .upsert(rows, { onConflict: "entity_id,style_id" }).select("id");
    seeded = (up || []).length;
  }
  return { seeded, deactivated };
}
