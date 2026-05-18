// Entity-card tool executors for the Ask AI handler.
//
// Single-call pre-aggregated snapshots — Tier 1D of the Ask AI
// improvement plan. When the operator names a single style or customer
// and wants a quick read, these tools deliver the whole context block
// in one round trip instead of the find_customer → find_style →
// describe_table → query_shipments → query_open_sos dance.
//
// Cards are read-only snapshots — they don't mutate the grid. Use for
// "how is X doing?" / "snapshot of Y" orientation questions, not for
// specific numbers (use the hot-path tools when the answer is a single
// figure).
//
// Lives separately from executors.js per architecture invariant #2 —
// keeps each module under the 700-line ceiling.

import { canonName, clampString } from "./utils.js";
import { FIND_CUSTOMER_LIMIT, QUERY_ROW_LIMIT } from "./constants.js";

// Compute T3 window (trailing 3 months from today) + LY window (T3
// shifted back 12 months). Used by both card tools.
export function defaultCardWindows(now = new Date()) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const t3End = iso(now);
  const t3Start = (() => { const d = new Date(now); d.setMonth(d.getMonth() - 3); return iso(d); })();
  const lyEnd = (() => { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return iso(d); })();
  const lyStart = (() => { const d = new Date(now); d.setMonth(d.getMonth() - 15); return iso(d); })();
  return { t3Start, t3End, lyStart, lyEnd };
}

// Growth share per ROF convention: (current − prior) / current. Returns
// a fraction (0.687 for 68.7%). Edge cases: current<=0 → null (formula
// breaks); prior<=0 with current>0 → 1 (entire current is incremental).
export function growthShare(current, prior) {
  if (current <= 0) return null;
  if (prior <= 0) return 1;
  return (current - prior) / current;
}

// Aggregate shipments for a set of sku_ids over a date window.
// Returns { qty, revenue, byCustomer: Map<customer_id, {qty, revenue}> }.
async function aggregateShipmentsForSkus(db, skuIds, dateStart, dateEnd) {
  if (!skuIds || skuIds.length === 0) return { qty: 0, revenue: 0, byCustomer: new Map() };
  // Bucket sku_ids into batches of 100 to stay under PostgREST URL limits.
  // For card use the ID list rarely exceeds a few hundred (one style's
  // variants), but be defensive.
  const byCustomer = new Map();
  let totalQty = 0;
  let totalRev = 0;
  for (let i = 0; i < skuIds.length; i += 100) {
    const batch = skuIds.slice(i, i + 100);
    const { data, error } = await db
      .from("ip_sales_history_wholesale")
      .select("customer_id, qty, net_amount")
      .gte("txn_date", dateStart)
      .lte("txn_date", dateEnd)
      .in("sku_id", batch)
      .limit(QUERY_ROW_LIMIT);
    if (error) return { error: error.message, qty: 0, revenue: 0, byCustomer };
    for (const r of (data || [])) {
      const qty = Number(r.qty || 0);
      const rev = Number(r.net_amount || 0);
      totalQty += qty;
      totalRev += rev;
      if (!r.customer_id) continue;
      if (!byCustomer.has(r.customer_id)) byCustomer.set(r.customer_id, { qty: 0, revenue: 0 });
      const c = byCustomer.get(r.customer_id);
      c.qty += qty;
      c.revenue += rev;
    }
  }
  return { qty: totalQty, revenue: totalRev, byCustomer };
}

// Aggregate shipments for a set of customer_ids over a date window.
// Returns { qty, revenue, bySku: Map<sku_id, {qty, revenue}> }.
async function aggregateShipmentsForCustomers(db, customerIds, dateStart, dateEnd) {
  if (!customerIds || customerIds.length === 0) return { qty: 0, revenue: 0, bySku: new Map() };
  const bySku = new Map();
  let totalQty = 0;
  let totalRev = 0;
  for (let i = 0; i < customerIds.length; i += 100) {
    const batch = customerIds.slice(i, i + 100);
    const { data, error } = await db
      .from("ip_sales_history_wholesale")
      .select("sku_id, qty, net_amount")
      .gte("txn_date", dateStart)
      .lte("txn_date", dateEnd)
      .in("customer_id", batch)
      .limit(QUERY_ROW_LIMIT);
    if (error) return { error: error.message, qty: 0, revenue: 0, bySku };
    for (const r of (data || [])) {
      const qty = Number(r.qty || 0);
      const rev = Number(r.net_amount || 0);
      totalQty += qty;
      totalRev += rev;
      if (!r.sku_id) continue;
      if (!bySku.has(r.sku_id)) bySku.set(r.sku_id, { qty: 0, revenue: 0 });
      const s = bySku.get(r.sku_id);
      s.qty += qty;
      s.revenue += rev;
    }
  }
  return { qty: totalQty, revenue: totalRev, bySku };
}

// Per-style snapshot card. One round trip from Claude's perspective,
// 5-7 sub-queries server-side. Returns:
//   { style, sales (t3 + ly + growth + top customers), open_commitments }
export async function tool_style_card(db, input) {
  const style_code = clampString(input?.style_code, 50).trim();
  if (!style_code) return { error: "style_code required" };

  // 1. Master rows under this style (variant count + pack_size).
  const { data: masters, error: mastersErr } = await db
    .from("ip_item_master")
    .select("id, sku_code, style_code, description, color, size, pack_size, active, attributes")
    .eq("style_code", style_code)
    .limit(500);
  if (mastersErr) return { error: mastersErr.message };
  if (!masters || masters.length === 0) {
    return { error: `No master rows found for style_code='${style_code}'.` };
  }
  const skuIds = masters.map(m => m.id);
  const variants = masters.length;
  const distinctColors = Array.from(new Set(masters.map(m => m.color).filter(Boolean))).slice(0, 20);
  const packSize = Math.max(1, ...masters.map(m => m.pack_size || 1));
  const styleLevelRow = masters.find(m => m.sku_code === m.style_code) || masters[0];
  const category = styleLevelRow?.attributes?.group_name || null;
  const subCategory = styleLevelRow?.attributes?.category_name || null;
  const sampleDescription = styleLevelRow?.description || null;

  // 2. Sales windows.
  const { t3Start, t3End, lyStart, lyEnd } = defaultCardWindows();

  // 3. Parallel sub-queries: T3 shipments, LY shipments, open SOs, open POs.
  const [t3Agg, lyAgg, openSosResult, openPosResult] = await Promise.all([
    aggregateShipmentsForSkus(db, skuIds, t3Start, t3End),
    aggregateShipmentsForSkus(db, skuIds, lyStart, lyEnd),
    db.from("ip_open_sales_orders").select("qty_open, unit_price").in("sku_id", skuIds.slice(0, 100)).limit(QUERY_ROW_LIMIT),
    db.from("ip_open_purchase_orders").select("qty_open, unit_cost").in("sku_id", skuIds.slice(0, 100)).limit(QUERY_ROW_LIMIT),
  ]);
  if (t3Agg.error) return { error: `t3 shipments: ${t3Agg.error}` };
  if (lyAgg.error) return { error: `ly shipments: ${lyAgg.error}` };

  // 4. Resolve top T3 customers by revenue (limit 5).
  const topCustomerEntries = Array.from(t3Agg.byCustomer.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5);
  const topCustomerIds = topCustomerEntries.map(([id]) => id);
  let customerNameById = new Map();
  if (topCustomerIds.length > 0) {
    const { data: custs } = await db
      .from("ip_customer_master")
      .select("id, name")
      .in("id", topCustomerIds);
    for (const c of (custs || [])) {
      if (c.id && c.name) customerNameById.set(c.id, c.name);
    }
  }
  const topCustomers = topCustomerEntries.map(([id, agg]) => ({
    customer_id: id,
    name: customerNameById.get(id) || "(unknown)",
    t3_revenue: agg.revenue,
    t3_qty: agg.qty,
  }));

  // 5. Open commitments (rough $ totals; capped at 100 sku_ids batch above).
  const openSoTotal = (openSosResult.data || []).reduce(
    (s, r) => s + Number(r.qty_open || 0) * Number(r.unit_price || 0), 0,
  );
  const openPoTotal = (openPosResult.data || []).reduce(
    (s, r) => s + Number(r.qty_open || 0) * Number(r.unit_cost || 0), 0,
  );

  return {
    style: {
      style_code,
      description: sampleDescription,
      category,
      sub_category: subCategory,
      pack_size: packSize,
      is_prepack: packSize > 1,
      variant_count: variants,
      distinct_colors: distinctColors,
    },
    sales: {
      t3_window: { start: t3Start, end: t3End },
      ly_window: { start: lyStart, end: lyEnd },
      t3: { qty: t3Agg.qty, revenue: t3Agg.revenue },
      ly: { qty: lyAgg.qty, revenue: lyAgg.revenue },
      growth_qty:     growthShare(t3Agg.qty,     lyAgg.qty),
      growth_revenue: growthShare(t3Agg.revenue, lyAgg.revenue),
      top_customers_t3: topCustomers,
    },
    open_commitments: {
      open_sales_orders_usd: openSoTotal,
      open_purchase_orders_usd: openPoTotal,
    },
    notes: [
      packSize > 1 ? `Sales qty above is at Xoro's recorded grain — may be pack-count for this prepack (pack_size=${packSize}). Multiply by ${packSize} for unit-grain.` : null,
    ].filter(Boolean),
  };
}

// Per-customer snapshot card. Accepts either customer_id (uuid) or
// customer_name (free-text, resolved via find_customer's logic).
export async function tool_customer_card(db, input) {
  const customerName = clampString(input?.customer_name, 100).trim();
  const customerIdInput = clampString(input?.customer_id, 64).trim();
  if (!customerName && !customerIdInput) {
    return { error: "customer_id or customer_name required" };
  }

  // 1. Resolve customer IDs. Xoro name drift means one logical customer
  // can have multiple rows.
  let customerIds = [];
  let resolvedRows = [];
  if (customerIdInput) {
    const { data, error } = await db
      .from("ip_customer_master")
      .select("id, name, customer_code")
      .eq("id", customerIdInput);
    if (error) return { error: error.message };
    resolvedRows = data || [];
    customerIds = resolvedRows.map(r => r.id);
  } else {
    const firstWord = customerName.split(/\s+/)[0] || customerName;
    const target = canonName(customerName);
    const { data, error } = await db
      .from("ip_customer_master")
      .select("id, name, customer_code")
      .ilike("name", `${firstWord}%`)
      .limit(FIND_CUSTOMER_LIMIT);
    if (error) return { error: error.message };
    resolvedRows = (data || []).filter(r => {
      const c = canonName(r.name || "");
      return c === target || c.startsWith(target) || target.startsWith(c);
    });
    customerIds = resolvedRows.map(r => r.id);
  }
  if (customerIds.length === 0) {
    return { error: `No customer match for '${customerName || customerIdInput}'.` };
  }

  // 2. Sales windows.
  const { t3Start, t3End, lyStart, lyEnd } = defaultCardWindows();

  // 3. Parallel sub-queries: T3 + LY shipments + open SOs (open POs
  // aren't customer-scoped, skip).
  const [t3Agg, lyAgg, openSosResult] = await Promise.all([
    aggregateShipmentsForCustomers(db, customerIds, t3Start, t3End),
    aggregateShipmentsForCustomers(db, customerIds, lyStart, lyEnd),
    db.from("ip_open_sales_orders").select("qty_open, unit_price, ship_date").in("customer_id", customerIds).limit(QUERY_ROW_LIMIT),
  ]);
  if (t3Agg.error) return { error: `t3 shipments: ${t3Agg.error}` };
  if (lyAgg.error) return { error: `ly shipments: ${lyAgg.error}` };

  // 4. Resolve top T3 styles by revenue (limit 5).
  const topSkuEntries = Array.from(t3Agg.bySku.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 20);
  const topSkuIds = topSkuEntries.map(([id]) => id);
  let skuStyleById = new Map();
  if (topSkuIds.length > 0) {
    const { data: masters } = await db
      .from("ip_item_master")
      .select("id, style_code, description")
      .in("id", topSkuIds);
    for (const m of (masters || [])) {
      if (m.id) skuStyleById.set(m.id, { style_code: m.style_code, description: m.description });
    }
  }
  // Aggregate by style_code (since one style has many sku_ids).
  const styleRevenue = new Map();
  for (const [skuId, agg] of topSkuEntries) {
    const meta = skuStyleById.get(skuId);
    const key = meta?.style_code || "(unmatched)";
    if (!styleRevenue.has(key)) styleRevenue.set(key, { qty: 0, revenue: 0, description: meta?.description || null });
    const s = styleRevenue.get(key);
    s.qty += agg.qty;
    s.revenue += agg.revenue;
  }
  const topStyles = Array.from(styleRevenue.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5)
    .map(([style_code, v]) => ({ style_code, description: v.description, t3_revenue: v.revenue, t3_qty: v.qty }));

  // 5. Open SOs total $.
  const openSoTotal = (openSosResult.data || []).reduce(
    (s, r) => s + Number(r.qty_open || 0) * Number(r.unit_price || 0), 0,
  );

  return {
    customer: {
      ids: customerIds,
      canonical_names: resolvedRows.map(r => r.name).filter(Boolean),
      customer_codes: resolvedRows.map(r => r.customer_code).filter(Boolean),
      alias_count: customerIds.length,
    },
    sales: {
      t3_window: { start: t3Start, end: t3End },
      ly_window: { start: lyStart, end: lyEnd },
      t3: { qty: t3Agg.qty, revenue: t3Agg.revenue },
      ly: { qty: lyAgg.qty, revenue: lyAgg.revenue },
      growth_qty:     growthShare(t3Agg.qty,     lyAgg.qty),
      growth_revenue: growthShare(t3Agg.revenue, lyAgg.revenue),
      top_styles_t3: topStyles,
    },
    open_commitments: {
      open_sales_orders_usd: openSoTotal,
    },
    notes: customerIds.length > 1 ? [`Resolved ${customerIds.length} ip_customer_master rows under this name — typical of Xoro spelling drift.`] : [],
  };
}
