// api/internal/recon/dso-dpo
//
// Monthly DSO (AR) / DPO (AP) derived from the cash-side subledger's real
// application dates (v_dso_dpo_monthly, migration 20260992000000).
//
//   GET /api/internal/recon/dso-dpo?
//        from=YYYY-MM-DD   (optional, inclusive lower bound on month)
//       &to=YYYY-MM-DD     (optional, inclusive upper bound on month)
//
// Returns:
//   200 { count, rows: [ { month, metric:'DSO'|'DPO', weighted_days,
//                          total_cents, n_applications } ... ] }
//
// weighted_days = amount-weighted average days between invoice date and the
// cash settlement date (receipt application for AR, payment for AP), grouped
// by the month the cash was applied.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTITY_CODE = "ROF";

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

/** Pure query validator — exported for unit tests. */
export function parseDsoDpoQuery(params) {
  const out = { from: null, to: null };
  for (const key of ["from", "to"]) {
    if (params[key] !== undefined && params[key] !== "") {
      const v = String(params[key]).trim();
      if (!DATE_RE.test(v)) return { error: `${key} must be YYYY-MM-DD (got "${v}")` };
      out[key] = v;
    }
  }
  if (out.from && out.to && out.from > out.to) return { error: "from must be <= to" };
  return { data: out };
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
  const v = parseDsoDpoQuery(Object.fromEntries(url.searchParams.entries()));
  if (v.error) return res.status(400).json({ error: v.error });
  const f = v.data;

  const { data: entity } = await admin.from("entities").select("id").eq("code", ENTITY_CODE).maybeSingle();
  if (!entity) return res.status(500).json({ error: `Default entity (${ENTITY_CODE}) not found` });

  let query = admin
    .from("v_dso_dpo_monthly")
    .select("month, metric, weighted_days, total_cents, n_applications")
    .eq("entity_id", entity.id)
    .order("month", { ascending: false })
    .order("metric", { ascending: true });

  if (f.from) query = query.gte("month", f.from);
  if (f.to) query = query.lte("month", f.to);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  return res.status(200).json({ count: rows.length, rows });
}
