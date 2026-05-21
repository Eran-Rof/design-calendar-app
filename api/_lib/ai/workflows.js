// Cross-app workflow executor for the Ask AI handler (Tier 3I).
//
// A workflow is a NAMED recipe of database queries chained server-side.
// The AI invokes one with `start_workflow(workflow_name, params)`; the
// executor runs every step in sequence, threads results between them,
// and returns a single rich payload. The AI then writes the operator-
// facing summary in answer_text.
//
// Why this shape instead of letting the AI orchestrate the chain itself:
//   - Predictable cost: a known workflow runs N queries every time.
//     AI-driven chaining can blow the budget on bad early decisions.
//   - Faster: no AI round-trip between steps.
//   - Auditable: the workflow code is the spec — easier to reason about
//     than a soft prompt nudging the AI to "do the right sequence."
//   - Operators can request a named workflow by name ("run the weekly
//     underperformer review") and get the same shape every time.
//
// Adding a new workflow: append an entry to WORKFLOWS. Each entry needs
// `name`, `description`, `params_schema` (for tool-defs.js), and an
// async `run(db, params, ctx)` that returns a JSON-serialisable payload.
// Pure helpers (date math, ranking) live alongside so they can be
// unit-tested without spinning a fake DB.

import { clampDate, clampString } from "./utils.js";

// Hard ceiling on rows accumulated across a paginated scan. Workflows
// aggregate sums/groups before returning so the payload to Claude stays
// small even when the underlying scan is large; the cap exists only as
// a runaway-guard. Set well above the realistic worst case (T3 wholesale
// shipments ~10k, LY ~40k) so we don't silently truncate.
const SCAN_HARD_CAP = 100_000;

// PostgREST default page size. The Supabase project hasn't raised
// db-max-rows, so any single request that asks for more than ~1k rows
// gets silently capped at 1000. pageAll() compensates by iterating in
// 1000-row windows via .range() until the result set is exhausted.
const PAGE_SIZE = 1000;

/**
 * Paginate a Supabase query that may return more than PAGE_SIZE rows.
 *
 * `buildQuery` is a factory that returns a fresh PostgREST query
 * builder on each call — required because Supabase JS builders are
 * single-use (once `.range()` is appended they can't be reused).
 * The query MUST include a stable `.order(...)` clause so the same
 * row never appears on two consecutive pages and no row is skipped
 * between pages. Most callers `.order("id")` since every relevant
 * table has a UUID primary key.
 *
 * Returns `{ data: [] }` on success or `{ error: string }` on the
 * first underlying error. Aborts (returns error) if SCAN_HARD_CAP is
 * hit — better to fail loudly than continue returning a truncated
 * snapshot that pretends to be complete.
 */
async function pageAll(buildQuery) {
  const out = [];
  for (let from = 0; from < SCAN_HARD_CAP; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { error: error.message };
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) return { data: out };
  }
  if (out.length >= SCAN_HARD_CAP) {
    return { error: `scan exceeded SCAN_HARD_CAP (${SCAN_HARD_CAP}) — refusing to silently truncate` };
  }
  return { data: out };
}

// ────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ────────────────────────────────────────────────────────────────────────

/**
 * Default T3 (trailing 3 months) + LY (T3 shifted -12mo) windows.
 * Pure — `now` injectable for tests.
 */
export function workflowWindows(now = new Date()) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const t3End = iso(now);
  const t3Start = (() => { const d = new Date(now); d.setMonth(d.getMonth() - 3); return iso(d); })();
  const lyEnd = (() => { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return iso(d); })();
  const lyStart = (() => { const d = new Date(now); d.setMonth(d.getMonth() - 15); return iso(d); })();
  return { t3Start, t3End, lyStart, lyEnd };
}

/**
 * Given a Map<style, {t3Revenue, lyRevenue, t3Qty, lyQty}>, return the
 * bottom-N by revenue decline (LY - T3 as a positive $ when T3 < LY).
 * Styles with LY revenue <= 0 are skipped (no baseline to decline from).
 *
 * Pure — easy to test independently of DB shape.
 */
export function rankByRevenueDecline(byStyle, topN = 10) {
  const rows = [];
  for (const [style, r] of byStyle.entries()) {
    if ((r.lyRevenue || 0) <= 0) continue;
    const decline = (r.lyRevenue || 0) - (r.t3Revenue || 0);
    if (decline <= 0) continue;
    const declinePct = decline / r.lyRevenue;
    rows.push({
      style_code: style,
      t3_qty: Math.round(r.t3Qty || 0),
      ly_qty: Math.round(r.lyQty || 0),
      t3_revenue: Math.round(r.t3Revenue || 0),
      ly_revenue: Math.round(r.lyRevenue || 0),
      decline_revenue: Math.round(decline),
      decline_pct: Math.round(declinePct * 1000) / 10, // one decimal, %
    });
  }
  rows.sort((a, b) => b.decline_pct - a.decline_pct);
  return rows.slice(0, topN);
}

/**
 * Map<customer_id, {t3Revenue, lyRevenue}> → customers whose T3 revenue
 * is ≤ thresholdPct of LY revenue (default: ≤ 75%, i.e. dropped ≥ 25%).
 * Filters out customers with no LY baseline.
 */
export function rankByChurnRisk(byCustomer, thresholdPct = 0.75, topN = 20) {
  const rows = [];
  for (const [customerId, r] of byCustomer.entries()) {
    if ((r.lyRevenue || 0) <= 0) continue;
    const ratio = (r.t3Revenue || 0) / r.lyRevenue;
    if (ratio > thresholdPct) continue;
    rows.push({
      customer_id: customerId,
      customer_name: r.name || null,
      t3_revenue: Math.round(r.t3Revenue || 0),
      ly_revenue: Math.round(r.lyRevenue || 0),
      drop_pct: Math.round((1 - ratio) * 1000) / 10,
    });
  }
  rows.sort((a, b) => b.drop_pct - a.drop_pct);
  return rows.slice(0, topN);
}

// ────────────────────────────────────────────────────────────────────────
// Shared DB helpers
// ────────────────────────────────────────────────────────────────────────

// Pull style-level revenue/qty totals from ip_sales_history_wholesale
// over a date range. Returns Map<style_code, {qty, revenue}>.
// Bucketed via JOIN-by-fetch — sku_id → master row → style_code.
async function aggregateByStyle(db, dateStart, dateEnd) {
  // Pull raw shipments. The grain here is sku_id; we collapse to style
  // after a master-row lookup. Paginates because PostgREST caps single
  // requests at 1000 rows; without this the briefing was silently
  // under-reporting (~9k T3 wholesale rows seen as ~1k).
  const { data, error } = await pageAll(() => db
    .from("ip_sales_history_wholesale")
    .select("sku_id, qty, net_amount")
    .gte("txn_date", dateStart)
    .lte("txn_date", dateEnd)
    .order("id"));
  if (error) return { error };

  const skuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  if (skuIds.length === 0) return { byStyle: new Map() };

  // Resolve sku_id → style_code in batches.
  const skuToStyle = new Map();
  for (let i = 0; i < skuIds.length; i += 100) {
    const batch = skuIds.slice(i, i + 100);
    const { data: masters, error: e2 } = await db
      .from("ip_item_master")
      .select("id, style_code")
      .in("id", batch);
    if (e2) return { error: e2.message };
    for (const m of (masters || [])) if (m.style_code) skuToStyle.set(m.id, m.style_code);
  }

  const byStyle = new Map();
  for (const r of (data || [])) {
    const style = skuToStyle.get(r.sku_id);
    if (!style) continue;
    if (!byStyle.has(style)) byStyle.set(style, { qty: 0, revenue: 0 });
    const acc = byStyle.get(style);
    acc.qty += Number(r.qty || 0);
    acc.revenue += Number(r.net_amount || 0);
  }
  return { byStyle };
}

// Pull customer-level revenue totals from ip_sales_history_wholesale
// over a date range. Returns Map<customer_id, {qty, revenue}>.
async function aggregateByCustomer(db, dateStart, dateEnd) {
  const { data, error } = await pageAll(() => db
    .from("ip_sales_history_wholesale")
    .select("customer_id, qty, net_amount")
    .gte("txn_date", dateStart)
    .lte("txn_date", dateEnd)
    .order("id"));
  if (error) return { error };

  const byCustomer = new Map();
  for (const r of (data || [])) {
    if (!r.customer_id) continue;
    if (!byCustomer.has(r.customer_id)) byCustomer.set(r.customer_id, { qty: 0, revenue: 0 });
    const acc = byCustomer.get(r.customer_id);
    acc.qty += Number(r.qty || 0);
    acc.revenue += Number(r.net_amount || 0);
  }
  return { byCustomer };
}

// Resolve customer IDs → names (best-effort, returns the same Map).
async function attachCustomerNames(db, byCustomer) {
  const ids = Array.from(byCustomer.keys());
  if (ids.length === 0) return byCustomer;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { data, error } = await db
      .from("ip_customer_master")
      .select("id, name")
      .in("id", batch);
    if (error) continue;
    for (const c of (data || [])) {
      if (byCustomer.has(c.id)) byCustomer.get(c.id).name = c.name;
    }
  }
  return byCustomer;
}

// Open-PO exposure for a set of style_codes. Returns Map<style, {qty, value}>.
async function openPoExposureByStyle(db, styleCodes) {
  if (!styleCodes || styleCodes.length === 0) return new Map();
  // Resolve style_codes → sku_ids first.
  const skuToStyle = new Map();
  for (let i = 0; i < styleCodes.length; i += 50) {
    const batch = styleCodes.slice(i, i + 50);
    const { data, error } = await db
      .from("ip_item_master")
      .select("id, style_code")
      .in("style_code", batch);
    if (error) continue;
    for (const m of (data || [])) if (m.style_code) skuToStyle.set(m.id, m.style_code);
  }
  const skuIds = Array.from(skuToStyle.keys());
  if (skuIds.length === 0) return new Map();

  const byStyle = new Map();
  for (let i = 0; i < skuIds.length; i += 100) {
    const batch = skuIds.slice(i, i + 100);
    const { data, error } = await pageAll(() => db
      .from("ip_open_purchase_orders")
      .select("sku_id, qty_open, unit_cost")
      .in("sku_id", batch)
      .gt("qty_open", 0)
      .order("id"));
    if (error) continue;
    for (const r of (data || [])) {
      const style = skuToStyle.get(r.sku_id);
      if (!style) continue;
      const qty = Number(r.qty_open || 0);
      const value = qty * Number(r.unit_cost || 0);
      if (!byStyle.has(style)) byStyle.set(style, { qty: 0, value: 0 });
      const acc = byStyle.get(style);
      acc.qty += qty;
      acc.value += value;
    }
  }
  return byStyle;
}

// Open-SO exposure for a set of customer_ids. Returns Map<customer_id, {qty, value}>.
async function openSoExposureByCustomer(db, customerIds) {
  if (!customerIds || customerIds.length === 0) return new Map();
  const byCustomer = new Map();
  for (let i = 0; i < customerIds.length; i += 100) {
    const batch = customerIds.slice(i, i + 100);
    const { data, error } = await pageAll(() => db
      .from("ip_open_sales_orders")
      .select("customer_id, qty_open, unit_price")
      .in("customer_id", batch)
      .gt("qty_open", 0)
      .order("id"));
    if (error) continue;
    for (const r of (data || [])) {
      const qty = Number(r.qty_open || 0);
      const value = qty * Number(r.unit_price || 0);
      if (!byCustomer.has(r.customer_id)) byCustomer.set(r.customer_id, { qty: 0, value: 0 });
      const acc = byCustomer.get(r.customer_id);
      acc.qty += qty;
      acc.value += value;
    }
  }
  return byCustomer;
}

// ────────────────────────────────────────────────────────────────────────
// Workflow registry
// ────────────────────────────────────────────────────────────────────────

export const WORKFLOWS = [
  {
    name: "underperformer_review",
    description: "Find the top N styles whose T3 (trailing 3 months) revenue dropped vs LY (same window one year earlier), and surface their open-PO exposure so the operator can consider cancellation. Output is ranked by % revenue decline.",
    params_schema: {
      type: "object",
      properties: {
        top_n: { type: "integer", description: "How many underperformers to return. Default 10, max 25." },
      },
      additionalProperties: false,
    },
    async run(db, params) {
      const topN = Math.min(Math.max(1, Number(params?.top_n) || 10), 25);
      const { t3Start, t3End, lyStart, lyEnd } = workflowWindows();

      const [t3, ly] = await Promise.all([
        aggregateByStyle(db, t3Start, t3End),
        aggregateByStyle(db, lyStart, lyEnd),
      ]);
      if (t3.error) return { error: `T3 aggregate failed: ${t3.error}` };
      if (ly.error) return { error: `LY aggregate failed: ${ly.error}` };

      const merged = new Map();
      for (const [style, r] of t3.byStyle.entries()) {
        merged.set(style, { t3Qty: r.qty, t3Revenue: r.revenue, lyQty: 0, lyRevenue: 0 });
      }
      for (const [style, r] of ly.byStyle.entries()) {
        if (!merged.has(style)) merged.set(style, { t3Qty: 0, t3Revenue: 0, lyQty: 0, lyRevenue: 0 });
        const m = merged.get(style);
        m.lyQty = r.qty;
        m.lyRevenue = r.revenue;
      }

      const ranked = rankByRevenueDecline(merged, topN);
      const openPo = await openPoExposureByStyle(db, ranked.map(r => r.style_code));
      for (const row of ranked) {
        const exp = openPo.get(row.style_code);
        row.open_po_qty = exp ? Math.round(exp.qty) : 0;
        row.open_po_value = exp ? Math.round(exp.value) : 0;
      }

      return {
        workflow: "underperformer_review",
        windows: { t3: { from: t3Start, to: t3End }, ly: { from: lyStart, to: lyEnd } },
        count: ranked.length,
        underperformers: ranked,
        notes: [
          "Ranked by revenue decline %, descending.",
          "open_po_qty/value = currently-open POs for the SAME style — candidates to review for cancellation.",
          "Styles with LY revenue ≤ 0 or T3 ≥ LY are excluded (no decline to flag).",
        ],
      };
    },
  },

  {
    name: "customer_churn_check",
    description: "Find customers whose T3 (trailing 3 months) revenue dropped ≥ 25% vs LY (same window one year earlier). Returns their open-SO commitment value so the operator knows what's still in the pipe before reaching out.",
    params_schema: {
      type: "object",
      properties: {
        drop_threshold_pct: { type: "number", description: "Minimum % drop to flag (default 25 = 25%). Pass 50 for severe-only." },
        top_n: { type: "integer", description: "Max customers to return. Default 15, max 50." },
      },
      additionalProperties: false,
    },
    async run(db, params) {
      const threshold = Math.min(Math.max(0, Number(params?.drop_threshold_pct) || 25), 100);
      const topN = Math.min(Math.max(1, Number(params?.top_n) || 15), 50);
      const thresholdRatio = (100 - threshold) / 100;
      const { t3Start, t3End, lyStart, lyEnd } = workflowWindows();

      const [t3, ly] = await Promise.all([
        aggregateByCustomer(db, t3Start, t3End),
        aggregateByCustomer(db, lyStart, lyEnd),
      ]);
      if (t3.error) return { error: `T3 aggregate failed: ${t3.error}` };
      if (ly.error) return { error: `LY aggregate failed: ${ly.error}` };

      const merged = new Map();
      for (const [cid, r] of t3.byCustomer.entries()) {
        merged.set(cid, { t3Qty: r.qty, t3Revenue: r.revenue, lyQty: 0, lyRevenue: 0 });
      }
      for (const [cid, r] of ly.byCustomer.entries()) {
        if (!merged.has(cid)) merged.set(cid, { t3Qty: 0, t3Revenue: 0, lyQty: 0, lyRevenue: 0 });
        const m = merged.get(cid);
        m.lyQty = r.qty;
        m.lyRevenue = r.revenue;
      }
      await attachCustomerNames(db, merged);

      const ranked = rankByChurnRisk(merged, thresholdRatio, topN);
      const openSo = await openSoExposureByCustomer(db, ranked.map(r => r.customer_id));
      for (const row of ranked) {
        const exp = openSo.get(row.customer_id);
        row.open_so_qty = exp ? Math.round(exp.qty) : 0;
        row.open_so_value = exp ? Math.round(exp.value) : 0;
      }

      return {
        workflow: "customer_churn_check",
        windows: { t3: { from: t3Start, to: t3End }, ly: { from: lyStart, to: lyEnd } },
        threshold_pct: threshold,
        count: ranked.length,
        churn_risks: ranked,
        notes: [
          "Customers ranked by % revenue drop, largest first.",
          `Only customers with T3 ≤ ${100 - threshold}% of LY revenue are shown.`,
          "open_so_qty/value = currently-open sales orders the operator can use to gauge before reaching out.",
        ],
      };
    },
  },

  {
    name: "monday_briefing",
    description: "Weekly operator briefing: total T3 revenue + qty, top 5 customers by T3 revenue, top 5 styles by T3 revenue, count + $ value of currently-open SOs and POs. One-call dashboard for a Monday-morning kickoff.",
    params_schema: { type: "object", properties: {}, additionalProperties: false },
    async run(db) {
      const { t3Start, t3End } = workflowWindows();

      // Top customers + top styles in parallel (different aggregates of the
      // same shipment fact table — could be optimised to a single scan).
      const [byCust, byStyle] = await Promise.all([
        aggregateByCustomer(db, t3Start, t3End),
        aggregateByStyle(db, t3Start, t3End),
      ]);
      if (byCust.error) return { error: `customer agg failed: ${byCust.error}` };
      if (byStyle.error) return { error: `style agg failed: ${byStyle.error}` };

      await attachCustomerNames(db, byCust.byCustomer);

      const topCustomers = Array.from(byCust.byCustomer.entries())
        .map(([id, r]) => ({ customer_id: id, customer_name: r.name || null, t3_revenue: Math.round(r.revenue), t3_qty: Math.round(r.qty) }))
        .sort((a, b) => b.t3_revenue - a.t3_revenue)
        .slice(0, 5);
      const topStyles = Array.from(byStyle.byStyle.entries())
        .map(([style, r]) => ({ style_code: style, t3_revenue: Math.round(r.revenue), t3_qty: Math.round(r.qty) }))
        .sort((a, b) => b.t3_revenue - a.t3_revenue)
        .slice(0, 5);

      // Open SO + open PO snapshot. Pull totals only — operator clicks
      // through to the grids for line-item detail. Paginated because
      // the open-SO set runs ~5k lines; single requests get capped at
      // 1000 by PostgREST.
      const [soRes, poRes] = await Promise.all([
        pageAll(() => db.from("ip_open_sales_orders").select("qty_open, unit_price").gt("qty_open", 0).order("id")),
        pageAll(() => db.from("ip_open_purchase_orders").select("qty_open, unit_cost").gt("qty_open", 0).order("id")),
      ]);
      if (soRes.error) return { error: `open SO scan failed: ${soRes.error}` };
      if (poRes.error) return { error: `open PO scan failed: ${poRes.error}` };
      const soRows = soRes.data;
      const poRows = poRes.data;
      const openSo = (soRows || []).reduce((acc, r) => {
        const qty = Number(r.qty_open || 0);
        acc.qty += qty;
        acc.value += qty * Number(r.unit_price || 0);
        acc.lines += 1;
        return acc;
      }, { qty: 0, value: 0, lines: 0 });
      const openPo = (poRows || []).reduce((acc, r) => {
        const qty = Number(r.qty_open || 0);
        acc.qty += qty;
        acc.value += qty * Number(r.unit_cost || 0);
        acc.lines += 1;
        return acc;
      }, { qty: 0, value: 0, lines: 0 });

      const totals = Array.from(byCust.byCustomer.values()).reduce(
        (acc, r) => { acc.qty += r.qty; acc.revenue += r.revenue; return acc; },
        { qty: 0, revenue: 0 },
      );

      return {
        workflow: "monday_briefing",
        windows: { t3: { from: t3Start, to: t3End } },
        t3_totals: { qty: Math.round(totals.qty), revenue: Math.round(totals.revenue) },
        top_customers_by_t3_revenue: topCustomers,
        top_styles_by_t3_revenue:    topStyles,
        open_sales_orders:    { line_count: openSo.lines, qty_open: Math.round(openSo.qty), value: Math.round(openSo.value) },
        open_purchase_orders: { line_count: openPo.lines, qty_open: Math.round(openPo.qty), value: Math.round(openPo.value) },
        notes: [
          "Snapshot is T3 (trailing 3 months from today) for sales facts; open SO/PO are point-in-time.",
          "Use this as a kickoff dashboard — drill into specific styles/customers via style_card / customer_card.",
        ],
      };
    },
  },
];

const WORKFLOWS_BY_NAME = new Map(WORKFLOWS.map(w => [w.name, w]));

/**
 * tool_start_workflow — Ask AI tool executor.
 *
 * Input: { workflow_name, params? }
 * Output: { workflow, ...payload } from the workflow's run() OR { error }
 */
export async function tool_start_workflow(db, input) {
  const name = clampString(input?.workflow_name, 60).trim();
  if (!name) return { error: "workflow_name required" };
  const wf = WORKFLOWS_BY_NAME.get(name);
  if (!wf) {
    return {
      error: `Unknown workflow '${name}'. Available: ${WORKFLOWS.map(w => w.name).join(", ")}.`,
    };
  }
  try {
    return await wf.run(db, input?.params || {});
  } catch (err) {
    return { error: `workflow '${name}' failed: ${err?.message || err}` };
  }
}

/**
 * Lightweight listing for the tool description so Claude can advertise
 * the available workflows in operator-facing prose without us having to
 * hand-maintain a parallel registry.
 */
export function listWorkflows() {
  return WORKFLOWS.map(w => ({ name: w.name, description: w.description }));
}
