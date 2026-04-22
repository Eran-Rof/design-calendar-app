// api/internal/analytics/financial
//
// GET — financial dashboard rollup combining Phase 10 sources.
//   ?entity_id=<uuid>  optional; scope tax/scf to one entity
// Returns:
//   {
//     early_payment: { ytd_discount_captured, ytd_avg_annualized_return, acceptance_rate_pct },
//     fx_exposure: { by_currency: [{ currency, outstanding_amount, intl_payments_count }], total_outstanding_usd_est },
//     scf_utilization: { by_month: [{ month, utilization, capacity }], current_total_util, current_total_capacity },
//     tax_liability: { quarter: { start, end }, by_jurisdiction: [{ jurisdiction, tax_type, tax_owed }], total_tax_owed }
//   }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function round2(n) { return Math.round(n * 100) / 100; }

function currentQuarter(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const qStartMonth = Math.floor(m / 3) * 3;
  const start = new Date(Date.UTC(y, qStartMonth, 1));
  const end = new Date(Date.UTC(y, qStartMonth + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function ytdRange(now = new Date()) {
  return { start: `${now.getUTCFullYear()}-01-01`, end: now.toISOString().slice(0, 10) };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"] || null;

  const ytd = ytdRange();
  const quarter = currentQuarter();

  const [earlyPayment, fxExposure, scfUtilization, taxLiability] = await Promise.all([
    computeEarlyPayment(admin, ytd, entityId),
    computeFxExposure(admin, ytd),
    computeScfUtilization(admin, entityId),
    computeTaxLiability(admin, quarter, entityId),
  ]);

  return res.status(200).json({
    ranges: { ytd, quarter },
    early_payment: earlyPayment,
    fx_exposure: fxExposure,
    scf_utilization: scfUtilization,
    tax_liability: taxLiability,
  });
}

async function computeEarlyPayment(admin, ytd, entityId) {
  let q = admin.from("dynamic_discount_offers")
    .select("status, discount_pct, discount_amount, early_payment_date, original_due_date")
    .gte("offered_at", `${ytd.start}T00:00:00Z`)
    .lte("offered_at", `${ytd.end}T23:59:59Z`);
  if (entityId) q = q.eq("entity_id", entityId);
  const { data } = await q;
  const rows = data || [];
  const accepted = rows.filter((r) => r.status === "accepted" || r.status === "paid");
  const captured = accepted.reduce((s, r) => s + Number(r.discount_amount || 0), 0);
  const returns = accepted.map((r) => {
    const days = Math.max(1, Math.round((new Date(`${r.original_due_date}T00:00:00Z`).getTime() - new Date(`${r.early_payment_date}T00:00:00Z`).getTime()) / 86400000));
    return (Number(r.discount_pct || 0) / 100) * (365 / days) * 100;
  });
  const avg = returns.length ? returns.reduce((s, n) => s + n, 0) / returns.length : 0;
  const acceptanceRate = rows.length ? (accepted.length / rows.length) * 100 : 0;

  // Cost-of-capital comparison baseline — 6% APR as the "do nothing, leave cash in MM" default
  const costOfCapitalPct = Number(process.env.COST_OF_CAPITAL_PCT) || 6;

  return {
    ytd_discount_captured: round2(captured),
    ytd_avg_annualized_return_pct: round2(avg),
    acceptance_rate_pct: round2(acceptanceRate),
    cost_of_capital_pct: costOfCapitalPct,
    net_benefit_vs_capital_pct: round2(avg - costOfCapitalPct),
    offers_made: rows.length,
    offers_accepted: accepted.length,
  };
}

async function computeFxExposure(admin, ytd) {
  const { data } = await admin.from("international_payments")
    .select("from_currency, to_currency, from_amount, to_amount, status, created_at")
    .gte("created_at", `${ytd.start}T00:00:00Z`)
    .lte("created_at", `${ytd.end}T23:59:59Z`);
  const rows = data || [];
  const byCurrency = {};
  let total_outstanding_usd_est = 0;
  for (const r of rows) {
    if (r.status === "sent" || r.status === "converted") continue; // settled
    const ccy = r.to_currency;
    const b = (byCurrency[ccy] ||= { currency: ccy, outstanding_amount: 0, intl_payments_count: 0 });
    b.outstanding_amount += Number(r.to_amount || 0);
    b.intl_payments_count += 1;
    total_outstanding_usd_est += Number(r.from_amount || 0);
  }
  return {
    by_currency: Object.values(byCurrency).map((b) => ({ ...b, outstanding_amount: round2(b.outstanding_amount) }))
      .sort((a, b) => b.outstanding_amount - a.outstanding_amount),
    total_outstanding_usd_est: round2(total_outstanding_usd_est),
  };
}

async function computeScfUtilization(admin, entityId) {
  let q = admin.from("supply_chain_finance_programs").select("id, name, max_facility_amount, current_utilization, status");
  if (entityId) q = q.eq("entity_id", entityId);
  const { data: programs } = await q;

  let totalUtil = 0, totalCap = 0;
  for (const p of programs || []) {
    totalUtil += Number(p.current_utilization || 0);
    totalCap  += Number(p.max_facility_amount || 0);
  }

  // Rough month-over-month from finance_requests funded_at
  const since = new Date(); since.setUTCMonth(since.getUTCMonth() - 12); since.setUTCDate(1);
  let rq = admin.from("finance_requests").select("approved_amount, funded_at, status, program_id")
    .gte("funded_at", since.toISOString())
    .eq("status", "funded");
  if (entityId && (programs || []).length) rq = rq.in("program_id", (programs || []).map((p) => p.id));
  const { data: funded } = await rq;

  const byMonth = {};
  for (const f of funded || []) {
    const key = String(f.funded_at).slice(0, 7);
    const b = (byMonth[key] ||= { month: key, utilization: 0 });
    b.utilization += Number(f.approved_amount || 0);
  }
  const points = Object.keys(byMonth).sort().map((k) => ({ ...byMonth[k], utilization: round2(byMonth[k].utilization), capacity: round2(totalCap) }));

  return {
    programs: (programs || []).map((p) => ({
      id: p.id, name: p.name, status: p.status,
      capacity: Number(p.max_facility_amount || 0),
      utilization: Number(p.current_utilization || 0),
      pct: p.max_facility_amount > 0 ? round2((p.current_utilization / p.max_facility_amount) * 100) : 0,
    })),
    by_month: points,
    current_total_utilization: round2(totalUtil),
    current_total_capacity: round2(totalCap),
    utilization_pct: totalCap > 0 ? round2((totalUtil / totalCap) * 100) : 0,
  };
}

async function computeTaxLiability(admin, quarter) {
  const { data } = await admin.from("tax_calculations")
    .select("jurisdiction, tax_type, tax_amount, calculated_at")
    .gte("calculated_at", `${quarter.start}T00:00:00Z`)
    .lte("calculated_at", `${quarter.end}T23:59:59Z`);
  const rows = data || [];
  const byKey = {};
  let total = 0;
  for (const r of rows) {
    const key = `${r.jurisdiction}|${r.tax_type}`;
    const b = (byKey[key] ||= { jurisdiction: r.jurisdiction, tax_type: r.tax_type, tax_owed: 0 });
    b.tax_owed += Number(r.tax_amount || 0);
    total += Number(r.tax_amount || 0);
  }
  return {
    quarter,
    by_jurisdiction: Object.values(byKey).map((b) => ({ ...b, tax_owed: round2(b.tax_owed) }))
      .sort((a, b) => b.tax_owed - a.tax_owed),
    total_tax_owed: round2(total),
  };
}
