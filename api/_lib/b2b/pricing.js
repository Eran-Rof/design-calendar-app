// api/_lib/b2b/pricing.js
//
// P18-C/D — shared B2B wholesale price resolution. THE single place that turns
// (customer, customer_tier, style) into a unit price, so the catalog page and
// the order-create endpoint agree exactly. Server-side ONLY — prices are NEVER
// taken from client input.
//
// Resolution, most-specific first (within an in-effect, active row set):
//   1. customer-specific  (b2b_price_list.customer_id = session customer_id)
//   2. tier               (customer_id IS NULL AND customer_tier = customers.customer_tier)
//   3. default            (customer_id IS NULL AND customer_tier IS NULL)
// Ties within the same rank break to the lowest price_cents.

// Pick the single best price row for ONE style from its candidate rows.
// `today` = ISO YYYY-MM-DD (honours effective_from/to); `tier` = customer tier.
export function pickBestPrice(rows, today, tier) {
  let best = null;
  let bestRank = Infinity;
  for (const r of rows) {
    if (r.is_active === false) continue;
    if (r.effective_from && String(r.effective_from) > today) continue;
    if (r.effective_to && String(r.effective_to) < today) continue;

    let rank;
    if (r.customer_id) {
      rank = 0; // customer-specific (query already scoped to THIS customer)
    } else if (r.customer_tier) {
      if (!tier || r.customer_tier !== tier) continue;
      rank = 1;
    } else {
      rank = 2;
    }

    if (rank < bestRank || (rank === bestRank && best && r.price_cents < best.price_cents)) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

// Resolve a price_cents-by-style_id map for a set of styleIds, scoped to one
// customer. Loads ONLY rows that can apply to this customer (its own
// customer-specific rows OR customer_id IS NULL tier/default rows) — never
// another customer's customer-specific prices.
//   → returns Map<style_id, { price_cents, currency, min_qty }>
export async function resolvePricesForCustomer(admin, customerId, styleIds, tier) {
  const out = new Map();
  if (!styleIds || styleIds.length === 0) return out;

  const { data: rows, error } = await admin
    .from("b2b_price_list")
    .select("style_id, customer_id, customer_tier, price_cents, currency, min_qty, effective_from, effective_to, is_active")
    .eq("is_active", true)
    .in("style_id", styleIds)
    .or(`customer_id.eq.${customerId},customer_id.is.null`);
  if (error) throw new Error(error.message);

  const byStyle = new Map();
  for (const r of rows || []) {
    if (!byStyle.has(r.style_id)) byStyle.set(r.style_id, []);
    byStyle.get(r.style_id).push(r);
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const sid of styleIds) {
    const best = pickBestPrice(byStyle.get(sid) || [], today, tier);
    if (best) {
      out.set(sid, {
        price_cents: best.price_cents,
        currency: best.currency,
        min_qty: Number(best.min_qty) || 0,
      });
    }
  }
  return out;
}
