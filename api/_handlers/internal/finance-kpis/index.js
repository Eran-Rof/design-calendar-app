// api/internal/finance-kpis  (h622)
//
// P24 / M46 — headline finance KPIs for the Reports & Analytics hub.
// Lightweight aggregates over the live ledgers (open AR / open AP / inventory
// value at cost / open sales orders / current open period). Everything is
// computed server-side; values are in cents (or counts).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function pageSum(admin, table, select, filter, reduce) {
  let total = 0, from = 0; const page = 1000;
  for (;;) {
    let q = admin.from(table).select(select).range(from, from + page - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) break;
    if (!data || data.length === 0) break;
    for (const r of data) total += reduce(r);
    if (data.length < page) break;
    from += page;
  }
  return total;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const POSTED_AR = ["posted", "sent", "partial_paid"];
  const POSTED_AP = ["posted", "approved", "sent", "partial_paid"];

  const [arOpen, apOpen, invValue] = await Promise.all([
    pageSum(admin, "ar_invoices", "total_amount_cents, paid_amount_cents, gl_status",
      (q) => q.in("gl_status", POSTED_AR), (r) => (Number(r.total_amount_cents) || 0) - (Number(r.paid_amount_cents) || 0)),
    pageSum(admin, "invoices", "total_amount_cents, paid_amount_cents, gl_status",
      (q) => q.in("gl_status", POSTED_AP), (r) => (Number(r.total_amount_cents) || 0) - (Number(r.paid_amount_cents) || 0)),
    pageSum(admin, "inventory_layers", "remaining_qty, unit_cost_cents",
      (q) => q.gt("remaining_qty", 0), (r) => Math.round((Number(r.remaining_qty) || 0) * (Number(r.unit_cost_cents) || 0))),
  ]);

  let openSoCount = 0;
  try {
    const { count } = await admin.from("sales_orders").select("id", { count: "exact", head: true })
      .in("status", ["confirmed", "allocated", "fulfilling", "shipped"]);
    openSoCount = count || 0;
  } catch { /* ignore */ }

  let currentPeriod = null;
  try {
    const { data } = await admin.from("gl_periods").select("fiscal_year, period_number, status, starts_on, ends_on")
      .eq("status", "open").order("fiscal_year", { ascending: false }).order("period_number", { ascending: false }).limit(1);
    if (data && data[0]) currentPeriod = data[0];
  } catch { /* ignore */ }

  return res.status(200).json({
    ar_open_cents: arOpen, ap_open_cents: apOpen, inventory_value_cents: invValue,
    open_so_count: openSoCount, current_period: currentPeriod,
    generated_at: new Date().toISOString(),
  });
}
