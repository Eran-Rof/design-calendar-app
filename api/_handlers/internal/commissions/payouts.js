// api/internal/commissions/payouts
//
// GET — list commission_payouts filtered by ?sales_rep_id=&period_id=.
// Returns joined sales_reps.display_name + gl_periods.fiscal_year/period_number.
//
// Tangerine P7-5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function parseListQuery(params) {
  const out = { sales_rep_id: null, period_id: null };
  const rep = params.get("sales_rep_id");
  if (rep) {
    if (!UUID_RE.test(rep)) return { error: "sales_rep_id must be UUID" };
    out.sales_rep_id = rep;
  }
  const pid = params.get("period_id");
  if (pid) {
    if (!UUID_RE.test(pid)) return { error: "period_id must be UUID" };
    out.period_id = pid;
  }
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = parseListQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  let q = admin
    .from("commission_payouts")
    .select(
      "id, entity_id, sales_rep_id, period_id, total_cents, payment_method, " +
      "paid_at, payout_je_id, notes, created_at, " +
      "sales_reps(display_name), gl_periods(fiscal_year, period_number, ends_on)",
    )
    .eq("entity_id", entity.id)
    .order("paid_at", { ascending: false })
    .limit(500);
  if (v.data.sales_rep_id) q = q.eq("sales_rep_id", v.data.sales_rep_id);
  if (v.data.period_id)    q = q.eq("period_id", v.data.period_id);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
