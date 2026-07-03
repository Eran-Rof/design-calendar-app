// api/_lib/sales-returns/creditMemo.js
//
// P19 / M23 — issue a customer credit memo from an RMA (sales_returns).
//
// This is the only place returns touch GL, and it reuses the existing P4
// `ar_credit_memo` posting rule entirely. Per disposition:
//   • restock → credit-memo line carries inventory_item_id + return_unit_cost
//     → arCreditMemo reverses revenue + AR AND re-adds the units to FIFO
//       (source_kind='credit_memo_return') + reverses COGS.
//   • scrap   → credit-memo line WITHOUT inventory_item_id → arCreditMemo only
//       reverses revenue + AR; the units stay expensed (already COGS'd at sale).
// Every line's revenue reversal is routed to the Sales Returns & Allowances
// contra-revenue account (4100) so the P&L shows returns separately. An
// optional restocking fee is a positive line to 4500 (Restocking Fee Income)
// that reduces the net credit.
//
// The pure builder is unit-tested; the orchestrator does the IO.

// Build the `ar_credit_memo` posting-event lines from RMA lines.
// returnsAccountId = 4100 (revenue reversal target). costBySku = Map<item_id,
// unit_cost_cents> resolved from the latest layer (required for restock lines).
// Throws if a restock line has no resolved cost (so the caller surfaces it).
// returnsByItem (optional) = Map<inventory_item_id, returns_account_id> resolved
// per the line's STYLE (style → customer default). When a line's item has an
// entry, its revenue reversal routes to that brand's Sales Returns account;
// otherwise it falls back to returnsAccountId (the entity-level 4100).
export function buildCreditMemoLines({ rmaLines, returnsAccountId, costByItem, returnsByItem }) {
  const lines = [];
  let i = 0;
  for (const rl of rmaLines || []) {
    if (rl.disposition === "pending") {
      throw new Error(`line ${rl.line_number}: disposition not set (restock or scrap) — cannot credit`);
    }
    const qty = Number(rl.qty_returned) || 0;
    if (qty <= 0) continue;
    const unitPrice = Number(rl.unit_price_cents) || 0;
    const lineTotalCents = Math.round(qty * unitPrice);
    const isRestock = rl.disposition === "restock" && rl.inventory_item_id;
    const lineReturnsAccountId =
      (rl.inventory_item_id && returnsByItem && returnsByItem.get(rl.inventory_item_id)) || returnsAccountId;

    const line = {
      id: rl.id,
      line_index: ++i,
      description: rl.description || (isRestock ? "Return (restock)" : "Return (scrap)"),
      revenue_account_id: lineReturnsAccountId, // per-style Sales Returns acct, else 4100
      unit_price_cents: unitPrice,
      line_total_cents: String(lineTotalCents),
    };
    if (isRestock) {
      const cost = costByItem && costByItem.get(rl.inventory_item_id);
      if (cost == null) {
        throw new Error(`line ${rl.line_number}: no inventory cost resolved for a restock line (item ${rl.inventory_item_id})`);
      }
      line.inventory_item_id = rl.inventory_item_id;
      line.quantity = qty;
      line.return_unit_cost_cents = Number(cost) || 0;
    }
    lines.push(line);
  }
  if (lines.length === 0) throw new Error("no creditable return lines");
  return lines;
}

// Latest layer unit cost per item (the return restock cost basis). Falls back
// to ip_item_avg_cost (dollars→cents) when the item has no layer. Returns a
// Map<item_id, unit_cost_cents>.
export async function resolveReturnCosts(admin, itemIds) {
  const out = new Map();
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  for (const itemId of ids) {
    const { data: layer } = await admin
      .from("inventory_layers")
      .select("unit_cost_cents")
      .eq("item_id", itemId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (layer && layer.unit_cost_cents != null) { out.set(itemId, Number(layer.unit_cost_cents)); continue; }
    // Fallback: avg cost (keyed by sku_code → need the item's sku_code).
    const { data: im } = await admin.from("ip_item_master").select("sku_code").eq("id", itemId).maybeSingle();
    if (im && im.sku_code) {
      const { data: avg } = await admin.from("ip_item_avg_cost").select("avg_cost").eq("sku_code", im.sku_code).maybeSingle();
      if (avg && avg.avg_cost != null) { out.set(itemId, Math.round(Number(avg.avg_cost) * 100)); continue; }
    }
    out.set(itemId, 0); // last resort — restock at $0 cost (still credits the customer)
  }
  return out;
}

async function findAccountByCode(admin, entityId, code) {
  const { data } = await admin.from("gl_accounts").select("id").eq("entity_id", entityId).eq("code", code).maybeSingle();
  return data ? data.id : null;
}
