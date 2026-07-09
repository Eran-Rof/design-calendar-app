// api/internal/factor/chargebacks
//
// Factor Module Phase 2 (Rosenthal) — GET the chargeback/creditback item
// detail (factor_chargebacks, from the monthly "Chargeback Report").
//
// Query params:
//   month  = YYYY-MM       — one accounting month (default: latest)
//   status = new|under_review|disputed|accepted|recovered — optional filter
//   (none) — latest month + { months: [...] } of available months
//
// Response: { month, months, rows } — rows carry the item grain plus the
// dispute columns. Reads are PAGINATED (a heavy month carries 2,400+ rows and
// PostgREST caps every read at max_rows=1000 regardless of .range()).
//
// Writes go through PATCH /api/internal/factor/chargebacks/:id ([id].js).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 30 };

const ISO_MONTH_RE = /^\d{4}-\d{2}$/;
export const CB_STATUSES = ["new", "under_review", "disputed", "accepted", "recovered"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function availableMonths(admin) {
  // Distinct report months via paginated column read (max_rows cap).
  const months = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("factor_chargebacks")
      .select("report_month")
      .order("report_month", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data || []) months.add(r.report_month);
    if (!data || data.length < PAGE) break;
  }
  return [...months].sort();
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const monthParam = (url.searchParams.get("month") || "").trim();
  const statusParam = (url.searchParams.get("status") || "").trim();
  if (monthParam && !ISO_MONTH_RE.test(monthParam)) {
    return res.status(400).json({ error: "month must be YYYY-MM" });
  }
  if (statusParam && !CB_STATUSES.includes(statusParam)) {
    return res.status(400).json({ error: `status must be one of ${CB_STATUSES.join(", ")}` });
  }

  try {
    const months = await availableMonths(admin);
    const month = monthParam
      ? months.find((m) => m.startsWith(`${monthParam}-`)) || null
      : months[months.length - 1] || null;
    if (!month) return res.status(200).json({ month: null, months, rows: [] });

    const rows = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      let q = admin
        .from("factor_chargebacks")
        .select("id, report_month, factor_customer_no, customer_name, client_customer, item_num, item_date, cb_date, batch, amount_cents, item_type, reason, reason_code, reference, status, notes, updated_by, updated_at, customer_id")
        .eq("report_month", month)
        .order("customer_name", { ascending: true })
        .order("cb_date", { ascending: true })
        .order("item_num", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (statusParam) q = q.eq("status", statusParam);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    return res.status(200).json({ month, months, rows });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
