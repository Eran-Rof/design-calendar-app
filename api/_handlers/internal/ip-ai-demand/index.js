// api/internal/ip-ai-demand
//
// POST — run AI demand prediction for a planning run.
//   Body: { planning_run_id, top_n_skus? (default 40) }
//   Response: { predictions: AIDemandPrediction[], context_summary, generated_at }
//
// Fetches internal data from Supabase, builds a structured context prompt,
// and calls Claude to generate per-SKU demand predictions with rationale
// and market signal callouts.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SB_URL        = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });

  const { planning_run_id, top_n_skus = 40 } = req.body ?? {};
  if (!planning_run_id) return res.status(400).json({ error: "planning_run_id required" });

  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── 1. Fetch the planning run ──────────────────────────────────────────
  const { data: run, error: runErr } = await db
    .from("ip_planning_runs")
    .select("*")
    .eq("id", planning_run_id)
    .single();
  if (runErr || !run) return res.status(404).json({ error: "Run not found" });

  const snapshotDate = run.source_snapshot_date;
  const horizonStart = run.horizon_start;
  const horizonEnd   = run.horizon_end;

  // 24 months of history before snapshot
  const historyFrom = subtractMonths(snapshotDate, 24);

  // ── 2. Parallel data fetch ─────────────────────────────────────────────
  const [
    { data: salesWholesale },
    { data: salesEcom },
    { data: inventory },
    { data: openPos },
    { data: forecast },
    { data: accuracy },
    { data: items },
    { data: categories },
  ] = await Promise.all([
    db.from("ip_wholesale_sales")
      .select("sku_id, customer_id, txn_date, qty, net_amount")
      .gte("txn_date", historyFrom)
      .lte("txn_date", snapshotDate)
      .order("txn_date", { ascending: false })
      .limit(50000),
    db.from("ip_ecom_sales")
      .select("sku_id, channel_id, txn_date, qty, net_amount")
      .gte("txn_date", historyFrom)
      .lte("txn_date", snapshotDate)
      .order("txn_date", { ascending: false })
      .limit(20000),
    db.from("ip_inventory_snapshot")
      .select("sku_id, qty_on_hand, qty_available, snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(5000),
    db.from("ip_open_purchase_orders")
      .select("sku_id, qty_open, expected_date")
      .limit(5000),
    db.from("ip_wholesale_forecast")
      .select("sku_id, period_start, final_forecast_qty, system_forecast_qty, forecast_method")
      .eq("planning_run_id", planning_run_id)
      .limit(10000),
    db.from("ip_forecast_accuracy")
      .select("sku_id, period_start, final_forecast_qty, actual_qty, pct_error_final, forecast_method")
      .eq("planning_run_id", planning_run_id)
      .limit(5000),
    db.from("ip_item_master").select("id, sku_code, description, category_id").limit(5000),
    db.from("ip_category_master").select("id, name").limit(200),
  ]);

  // ── 3. Build lookup maps ──────────────────────────────────────────────
  const itemById     = new Map((items || []).map(i => [i.id, i]));
  const categoryById = new Map((categories || []).map(c => [c.id, c.name]));

  // Latest inventory per SKU
  const latestInv = new Map();
  for (const s of (inventory || [])) {
    const ex = latestInv.get(s.sku_id);
    if (!ex || s.snapshot_date > ex.snapshot_date) latestInv.set(s.sku_id, s);
  }

  // Open PO qty per SKU
  const openPoQty = new Map();
  for (const p of (openPos || [])) {
    openPoQty.set(p.sku_id, (openPoQty.get(p.sku_id) || 0) + (p.qty_open || 0));
  }

  // Monthly wholesale sales per SKU
  const wSalesBySkuMonth = new Map();
  for (const s of (salesWholesale || [])) {
    const m = s.txn_date.slice(0, 7);
    const k = `${s.sku_id}|${m}`;
    const e = wSalesBySkuMonth.get(k) || { qty: 0, revenue: 0 };
    e.qty += s.qty || 0;
    e.revenue += s.net_amount || 0;
    wSalesBySkuMonth.set(k, e);
  }

  // Monthly ecom sales per SKU
  const eSalesBySkuMonth = new Map();
  for (const s of (salesEcom || [])) {
    const m = s.txn_date.slice(0, 7);
    const k = `${s.sku_id}|${m}`;
    const e = eSalesBySkuMonth.get(k) || { qty: 0, revenue: 0 };
    e.qty += s.qty || 0;
    e.revenue += s.net_amount || 0;
    eSalesBySkuMonth.set(k, e);
  }

  // ── 4. Select top N SKUs by total volume ──────────────────────────────
  const volumeBySku = new Map();
  for (const [k, v] of wSalesBySkuMonth) volumeBySku.set(k.split("|")[0], (volumeBySku.get(k.split("|")[0]) || 0) + v.qty);
  for (const [k, v] of eSalesBySkuMonth) volumeBySku.set(k.split("|")[0], (volumeBySku.get(k.split("|")[0]) || 0) + v.qty);
  const topSkus = [...volumeBySku.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top_n_skus)
    .map(([id]) => id);

  // ── 5. Build SKU summaries for the prompt ─────────────────────────────
  const skuSummaries = topSkus.map(skuId => {
    const item = itemById.get(skuId);
    const catName = item ? (categoryById.get(item.category_id) || "Unknown") : "Unknown";

    // Last 12 months wholesale by month (LY = months 13-24)
    const thisYearMonths = getLast12Months(snapshotDate);
    const lastYearMonths = getLast12Months(subtractMonths(snapshotDate, 12));

    const tyW = thisYearMonths.map(m => ({ m, qty: wSalesBySkuMonth.get(`${skuId}|${m}`)?.qty || 0 }));
    const lyW = lastYearMonths.map(m => ({ m, qty: wSalesBySkuMonth.get(`${skuId}|${m}`)?.qty || 0 }));
    const tyE = thisYearMonths.map(m => ({ m, qty: eSalesBySkuMonth.get(`${skuId}|${m}`)?.qty || 0 }));

    const tyWTotal = tyW.reduce((s, x) => s + x.qty, 0);
    const lyWTotal = lyW.reduce((s, x) => s + x.qty, 0);
    const tyETotal = tyE.reduce((s, x) => s + x.qty, 0);

    const inv = latestInv.get(skuId);
    const forecastRows = (forecast || []).filter(f => f.sku_id === skuId);
    const accRows = (accuracy || []).filter(a => a.sku_id === skuId);

    const avgAccuracy = accRows.length > 0
      ? accRows.reduce((s, a) => s + Math.abs(a.pct_error_final || 0), 0) / accRows.length
      : null;

    const forecastTotal = forecastRows.reduce((s, f) => s + (f.final_forecast_qty || 0), 0);

    return {
      sku_id: skuId,
      sku_code: item?.sku_code || skuId.slice(0, 8),
      description: item?.description || null,
      category: catName,
      on_hand: inv?.qty_on_hand || 0,
      available: inv?.qty_available || 0,
      open_po_qty: openPoQty.get(skuId) || 0,
      ty_wholesale_12m: tyWTotal,
      ly_wholesale_12m: lyWTotal,
      ty_ecom_12m: tyETotal,
      yoy_wholesale_pct: lyWTotal > 0 ? Math.round(((tyWTotal - lyWTotal) / lyWTotal) * 100) : null,
      monthly_wholesale_ty: tyW.map(x => `${x.m}:${x.qty}`).join(", "),
      monthly_wholesale_ly: lyW.map(x => `${x.m}:${x.qty}`).join(", "),
      horizon_forecast_total: forecastTotal,
      avg_abs_error_pct: avgAccuracy !== null ? Math.round(avgAccuracy * 100) : null,
    };
  });

  // Category-level summary
  const catSummary = {};
  for (const s of skuSummaries) {
    const c = catSummary[s.category] || { ty: 0, ly: 0, ecom: 0, skus: 0 };
    c.ty += s.ty_wholesale_12m;
    c.ly += s.ly_wholesale_12m;
    c.ecom += s.ty_ecom_12m;
    c.skus++;
    catSummary[s.category] = c;
  }

  // ── 6. Build the prompt ────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt({
    brand: "Ring of Fire Clothing",
    industry: "Apparel — action sports / streetwear",
    snapshotDate,
    horizonStart,
    horizonEnd,
    today,
    catSummary,
    skuSummaries,
  });

  // ── 7. Call Claude ────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  let message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    return res.status(502).json({ error: "Claude API error: " + err.message });
  }

  // ── 8. Parse response ─────────────────────────────────────────────────
  const rawText = message.content[0]?.text || "";
  let predictions;
  try {
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/(\[[\s\S]*\])/);
    predictions = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);
  } catch {
    return res.status(502).json({ error: "Claude returned unparseable JSON", raw: rawText.slice(0, 500) });
  }

  return res.status(200).json({
    predictions,
    context_summary: {
      run_name: run.name,
      snapshot_date: snapshotDate,
      horizon: `${horizonStart} → ${horizonEnd}`,
      skus_analyzed: topSkus.length,
      wholesale_txns: (salesWholesale || []).length,
      ecom_txns: (salesEcom || []).length,
      model: MODEL,
    },
    generated_at: new Date().toISOString(),
  });
}

// ── Prompt builder ─────────────────────────────────────────────────────────
function buildPrompt({ brand, industry, snapshotDate, horizonStart, horizonEnd, today, catSummary, skuSummaries }) {
  const catLines = Object.entries(catSummary)
    .sort((a, b) => b[1].ty - a[1].ty)
    .map(([cat, v]) => {
      const yoyPct = v.ly > 0 ? Math.round(((v.ty - v.ly) / v.ly) * 100) : null;
      const yoy = yoyPct !== null ? ` (${yoyPct > 0 ? "+" : ""}${yoyPct}% YoY)` : "";
      return `  ${cat}: ${v.skus} SKUs | wholesale TY ${v.ty.toLocaleString()} units${yoy} | ecom TY ${v.ecom.toLocaleString()} units`;
    }).join("\n");

  const skuLines = skuSummaries.map(s => {
    const yoy = s.yoy_wholesale_pct !== null ? ` | YoY ${s.yoy_wholesale_pct > 0 ? "+" : ""}${s.yoy_wholesale_pct}%` : "";
    const err = s.avg_abs_error_pct !== null ? ` | avg forecast error ${s.avg_abs_error_pct}%` : "";
    const inv = ` | on-hand ${s.on_hand} avail ${s.available} open-PO ${s.open_po_qty}`;
    const fc  = ` | horizon forecast ${s.horizon_forecast_total}`;
    return [
      `SKU: ${s.sku_code} [${s.sku_id}] — ${s.description || "(no desc)"} — ${s.category}`,
      `  TY wholesale 12m: ${s.ty_wholesale_12m} | LY: ${s.ly_wholesale_12m}${yoy} | ecom TY: ${s.ty_ecom_12m}${inv}${fc}${err}`,
      `  Monthly TY (ws): ${s.monthly_wholesale_ty}`,
      `  Monthly LY (ws): ${s.monthly_wholesale_ly}`,
    ].join("\n");
  }).join("\n\n");

  return `You are a demand planning analyst for ${brand}, an ${industry} brand.

Today: ${today}. Data snapshot: ${snapshotDate}. Planning horizon: ${horizonStart} to ${horizonEnd}.

## Category Overview (top SKUs, last 12 months)
${catLines}

## SKU-Level Detail
${skuLines}

## Your Task
Analyze the demand data above alongside your knowledge of:
- Apparel industry seasonality and buying cycles
- Action sports / streetwear market trends
- Macro consumer spending patterns for the current period
- Typical inventory health signals (stockouts that suppress recorded demand, safety stock norms)

For each SKU provided, generate a demand prediction for the planning horizon.

Return a JSON array (no prose, just the array) where each element is:
{
  "sku_id": "<uuid>",
  "sku_code": "<code>",
  "predicted_qty": <integer total units for horizon>,
  "confidence_score": <0.0–1.0>,
  "vs_current_forecast_pct": <signed integer % delta vs horizon_forecast_total, or null if no forecast>,
  "direction": "up" | "down" | "flat",
  "key_signals": ["<signal 1>", "<signal 2>", ...],
  "market_factors": ["<market factor 1>", ...],
  "flag": null | "review_urgently" | "potential_stockout" | "excess_risk" | "suppressed_demand",
  "rationale": "<2-3 sentence explanation>"
}

Rules:
- key_signals: specific data observations (e.g. "+28% YoY acceleration", "6-month declining trend", "inventory critically low")
- market_factors: external factors from your knowledge (e.g. "back-to-school seasonal lift", "streetwear demand softening", "spring drop cycle")
- flag review_urgently if confidence < 0.5 or vs_current_forecast_pct deviation > 25%
- flag potential_stockout if on-hand < 2 months of predicted run-rate
- flag excess_risk if on-hand + open-PO > 6 months of predicted run-rate
- flag suppressed_demand if LY data appears lower than category trends suggest (possible stockout artifact)
- Keep predicted_qty grounded in the data — do not hallucinate large swings without a clear signal

Return only the JSON array.`;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function subtractMonths(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

function getLast12Months(endIso) {
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(endIso + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}
