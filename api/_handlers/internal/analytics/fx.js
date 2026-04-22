// api/internal/analytics/fx
//
// GET — FX analytics: total fees paid by period, by currency pair,
//       and total foreign-currency payment volume.
//   ?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>  default: last 12 months
// Response:
//   { range, totals: { fx_fee_amount, foreign_volume, international_payments_count },
//     by_pair: [{ from, to, fee_total, volume }],
//     by_month: [{ month, fee_total, volume }] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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
  let from = url.searchParams.get("from");
  let to   = url.searchParams.get("to");
  if (!from) { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 12); from = d.toISOString().slice(0, 10); }
  if (!to)   to = new Date().toISOString().slice(0, 10);

  const { data, error } = await admin.from("international_payments")
    .select("from_amount, to_amount, fx_rate, fx_fee_amount, from_currency, to_currency, status, created_at")
    .gte("created_at", `${from}T00:00:00Z`)
    .lte("created_at", `${to}T23:59:59Z`);
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const totals = rows.reduce((acc, r) => ({
    fx_fee_amount: acc.fx_fee_amount + Number(r.fx_fee_amount || 0),
    foreign_volume: acc.foreign_volume + Number(r.from_amount || 0),
    international_payments_count: acc.international_payments_count + 1,
  }), { fx_fee_amount: 0, foreign_volume: 0, international_payments_count: 0 });

  const pairMap = {};
  const monthMap = {};
  for (const r of rows) {
    const key = `${r.from_currency}|${r.to_currency}`;
    const pb = (pairMap[key] ||= { from: r.from_currency, to: r.to_currency, fee_total: 0, volume: 0, count: 0 });
    pb.fee_total += Number(r.fx_fee_amount || 0);
    pb.volume    += Number(r.from_amount || 0);
    pb.count     += 1;

    const month = String(r.created_at).slice(0, 7);
    const mb = (monthMap[month] ||= { month, fee_total: 0, volume: 0, count: 0 });
    mb.fee_total += Number(r.fx_fee_amount || 0);
    mb.volume    += Number(r.from_amount || 0);
    mb.count     += 1;
  }

  return res.status(200).json({
    range: { from, to },
    totals: {
      fx_fee_amount: round2(totals.fx_fee_amount),
      foreign_volume: round2(totals.foreign_volume),
      international_payments_count: totals.international_payments_count,
    },
    by_pair: Object.values(pairMap).map((p) => ({ ...p, fee_total: round2(p.fee_total), volume: round2(p.volume) })).sort((a, b) => b.volume - a.volume),
    by_month: Object.values(monthMap).map((m) => ({ ...m, fee_total: round2(m.fee_total), volume: round2(m.volume) })).sort((a, b) => a.month.localeCompare(b.month)),
  });
}

function round2(n) { return Math.round(n * 100) / 100; }
