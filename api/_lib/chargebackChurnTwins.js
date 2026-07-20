// api/_lib/chargebackChurnTwins.js
//
// For offset-pair churn rows (churn_kind='offset_pair'), attach `churn_twin` —
// the OTHER leg of the pair (the reversing creditback, or the reversed
// chargeback) — so the worklist / detail drawer can say "reversed by creditback
// MM/DD/YYYY (item #...)". Both legs share churn_pair_id; the twin is the pair
// member whose id differs. A bounded extra query keyed on the page's pair ids.

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {Array<{id:string, churn_kind?:string|null, churn_pair_id?:string|null}>} rows  mutated in place
 * @returns {Promise<Array>} the same rows, each offset-pair row gaining
 *   `churn_twin: { id, item_num, cb_date, item_type, amount_cents } | null`
 */
export async function attachChurnTwins(admin, rows) {
  const list = rows || [];
  const pairIds = [...new Set(list.filter((r) => r.churn_kind === "offset_pair" && r.churn_pair_id).map((r) => r.churn_pair_id))];
  if (!pairIds.length) return list;

  const members = [];
  const CHUNK = 200;
  for (let i = 0; i < pairIds.length; i += CHUNK) {
    const { data, error } = await admin
      .from("factor_chargebacks")
      .select("id, churn_pair_id, item_num, cb_date, item_type, amount_cents")
      .in("churn_pair_id", pairIds.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    members.push(...(data || []));
  }

  const byPair = new Map();
  for (const m of members) {
    if (!byPair.has(m.churn_pair_id)) byPair.set(m.churn_pair_id, []);
    byPair.get(m.churn_pair_id).push(m);
  }
  for (const r of list) {
    if (r.churn_kind !== "offset_pair" || !r.churn_pair_id) continue;
    const twin = (byPair.get(r.churn_pair_id) || []).find((m) => m.id !== r.id) || null;
    r.churn_twin = twin
      ? { id: twin.id, item_num: twin.item_num, cb_date: twin.cb_date, item_type: twin.item_type, amount_cents: twin.amount_cents }
      : null;
  }
  return list;
}
