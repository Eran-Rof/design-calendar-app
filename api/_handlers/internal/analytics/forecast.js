// api/internal/analytics/forecast
//
// GET — per-vendor spend forecast for the next 3 months. Computes from
// the last 12 months of PO spend (rolling) via linear regression, then
// upserts into spend_forecasts so the history view can render prior
// forecasts.
//
// Response:
//   {
//     generated_at,
//     model_version: "linreg-v1",
//     vendors: [
//       { vendor_id, name,
//         history:  [{ month, spend }],     // 12 points
//         forecast: [{ period_start, period_end, amount, confidence_pct }],
//         trend_slope, avg_monthly
//       }
//     ]
//   }
//
// Query: ?vendor_id=uuid to scope to a single vendor.

import { createClient } from "@supabase/supabase-js";
import { linearForecast, monthKey, monthsBack } from "../../../_lib/analytics.js";

export const config = { maxDuration: 60 };

const MODEL_VERSION = "linreg-v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const vendorFilter = url.searchParams.get("vendor_id");

  const [vRes, posRes] = await Promise.all([
    admin.from("vendors").select("id, name").is("deleted_at", null),
    admin.from("tanda_pos").select("vendor_id, data"),
  ]);
  if (vRes.error)   return res.status(500).json({ error: vRes.error.message });
  if (posRes.error) return res.status(500).json({ error: posRes.error.message });

  const vendors = vendorFilter ? (vRes.data || []).filter((v) => v.id === vendorFilter) : (vRes.data || []);
  const allPos = posRes.data || [];

  // Monthly spend per vendor for last 12 months
  const months = monthsBack(12);
  const zero = () => months.reduce((acc, m) => { acc[m.key] = 0; return acc; }, {});
  const byVendor = new Map();
  for (const v of vendors) byVendor.set(v.id, { vendor: v, monthly: zero() });
  for (const po of allPos) {
    if (!po.data?.DateOrder) continue;
    if (po.data._archived) continue;
    const mk = monthKey(po.data.DateOrder);
    const bucket = byVendor.get(po.vendor_id);
    if (!bucket) continue;
    if (bucket.monthly[mk] === undefined) continue; // outside window
    bucket.monthly[mk] += Number(po.data.TotalAmount) || 0;
  }

  const generatedAt = new Date();
  const results = [];
  const toUpsert = [];

  for (const { vendor, monthly } of byVendor.values()) {
    const series = months.map((m) => monthly[m.key]);
    const avg = series.reduce((a, b) => a + b, 0) / Math.max(1, series.length);
    const { slope, forecast, confidence_pct } = linearForecast(series, 3);

    // Next 3 months periods (start of next month for N months)
    const next = [];
    for (let k = 1; k <= 3; k++) {
      const start = new Date(Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth() + k, 1));
      const end   = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      const amount = Math.round(forecast[k - 1] * 100) / 100;
      next.push({
        period_start: start.toISOString().slice(0, 10),
        period_end:   end.toISOString().slice(0, 10),
        amount,
        confidence_pct,
      });
      toUpsert.push({
        vendor_id: vendor.id,
        period_start: start.toISOString().slice(0, 10),
        period_end:   end.toISOString().slice(0, 10),
        forecast_amount: amount,
        confidence_pct,
        model_version: MODEL_VERSION,
        generated_at: generatedAt.toISOString(),
      });
    }

    results.push({
      vendor_id: vendor.id,
      name: vendor.name,
      history: months.map((m) => ({ month: m.key, spend: Math.round(monthly[m.key] * 100) / 100 })),
      forecast: next,
      trend_slope: Math.round(slope * 100) / 100,
      avg_monthly: Math.round(avg * 100) / 100,
    });
  }

  // Persist (best effort)
  if (toUpsert.length > 0) {
    await admin.from("spend_forecasts").upsert(toUpsert, { onConflict: "vendor_id,period_start,period_end" });
  }

  return res.status(200).json({
    generated_at: generatedAt.toISOString(),
    model_version: MODEL_VERSION,
    vendors: results.sort((a, b) => b.avg_monthly - a.avg_monthly),
  });
}
