// api/_lib/b2b/pricing.js
//
// P18-C/D — shared B2B wholesale price resolution. As of M43 this is a thin
// adapter over the unified pricing engine (api/_lib/pricing/engine.js), so the
// B2B portal and the internal SO/AR auto-fill resolve prices identically.
// Server-side ONLY — prices are NEVER taken from client input.
//
// The engine derives the customer's tier + assigned/own/default price lists
// itself, so the legacy `tier` argument here is accepted for backward-compat but
// ignored. Returns the same Map<style_id, {price_cents, currency, min_qty}> shape
// the catalog + order-create endpoints already consume (extra engine fields —
// base_price_cents, source_list_id, applied_promotion_id — are harmless).

import { resolvePricesForCustomer as engineResolve } from "../pricing/engine.js";

export async function resolvePricesForCustomer(admin, customerId, styleIds, _tier) {
  // Catalog/order base price uses qty 1 (style-level grain; qty breaks apply at
  // the line level via the engine's qty arg where a quantity is known).
  return engineResolve(admin, customerId, styleIds, 1);
}

// Legacy export retained for backward-compat (no longer the resolution path).
// Picks the best b2b_price_list-shaped row; superseded by the engine.
export function pickBestPrice(rows, today, tier) {
  let best = null, bestRank = Infinity;
  for (const r of rows) {
    if (r.is_active === false) continue;
    if (r.effective_from && String(r.effective_from) > today) continue;
    if (r.effective_to && String(r.effective_to) < today) continue;
    let rank;
    if (r.customer_id) rank = 0;
    else if (r.customer_tier) { if (!tier || r.customer_tier !== tier) continue; rank = 1; }
    else rank = 2;
    if (rank < bestRank || (rank === bestRank && best && r.price_cents < best.price_cents)) { best = r; bestRank = rank; }
  }
  return best;
}
