// api/internal/budget-range
//
// Tangerine FP&A — per-account BUDGET totals over an arbitrary posting-date
// window, for the Income Statement / Balance Sheet "Budget" column. The
// statement already fetches its own ACTUALS, so this returns budget only and
// the two stay consistent by construction.
//
// GET query params:
//   from=YYYY-MM-DD   (required)
//   to=YYYY-MM-DD     (required)
//   scenario=default  (optional)
//
// Calls budget_by_account_range(entity, from, to, scenario) (mig 20261030000000).
// Returns { from, to, scenario, rows: [{ account_id, code, name, account_type, budget_cents }] }.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function isISODate(v) { return typeof v === "string" && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")); }

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Respect X-Entity-ID (entity switcher); fall back to ROF.
  const hdr = (req.headers?.["x-entity-id"] || "").toString().trim();
  let entityId = null;
  if (hdr) { const { data } = await admin.from("entities").select("id").eq("id", hdr).maybeSingle(); if (data?.id) entityId = data.id; }
  if (!entityId) { const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle(); entityId = data?.id || null; }
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const scenario = ((url.searchParams.get("scenario") || "").trim()) || "default";
  if (!isISODate(from) || !isISODate(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (from > to) return res.status(400).json({ error: "from must be on or before to" });

  try {
    const { data, error } = await admin.rpc("budget_by_account_range", {
      p_entity_id: entityId, p_from_date: from, p_to_date: to, p_scenario: scenario,
    });
    if (error) return res.status(500).json({ error: error.message });
    const rows = (data || []).map((r) => ({
      account_id: r.account_id, code: r.code, name: r.name,
      account_type: r.account_type, budget_cents: Number(r.budget_cents) || 0,
    }));
    return res.status(200).json({ from, to, scenario, rows });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
