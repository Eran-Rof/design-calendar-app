// api/internal/recon/variances
//
// Tangerine P9-7 — list recon_variances for a given recon_run.
//
//   GET /api/internal/recon/variances?recon_run_id=<uuid>
//        [&status=within|over|cleared|suppressed]
//        [&source_tag=shopify|fba|walmart|faire|xoro_mirror|...]
//        [&limit=500&offset=0]
//
// Returns:
//   200 {
//     count, limit, offset,
//     variances: [ ...recon_variances rows... ]
//   }
//
// recon_run_id is REQUIRED — the variance list is scoped to a single
// parent run by design. Without the scope this endpoint would tail the
// global variance ledger, which doesn't match any of the dashboard's
// drill-down flows.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VARIANCE_STATUSES = ["within", "over", "cleared", "suppressed"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Internal-Token, X-Entity-ID",
  );
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Pure validator — exported for unit tests.
 */
export function parseVariancesQuery(params) {
  const out = {
    recon_run_id: null,
    status: null,
    source_tag: null,
    limit: 500,
    offset: 0,
  };

  if (!params.recon_run_id || String(params.recon_run_id).trim() === "") {
    return { error: "recon_run_id is required" };
  }
  const rid = String(params.recon_run_id).trim();
  if (!UUID_RE.test(rid)) {
    return { error: `recon_run_id must be a uuid (got "${rid}")` };
  }
  out.recon_run_id = rid;

  if (params.status !== undefined && params.status !== "") {
    const v = String(params.status).trim().toLowerCase();
    if (!VARIANCE_STATUSES.includes(v)) {
      return {
        error:
          `status "${v}" is not valid. ` +
          `Valid: ${VARIANCE_STATUSES.join(", ")}.`,
      };
    }
    out.status = v;
  }

  if (params.source_tag !== undefined && params.source_tag !== "") {
    // source_tag values are free-form (T10 enum but extensible). Trim
    // and accept; the dashboard already constrains via the SourceBadge
    // dropdown.
    out.source_tag = String(params.source_tag).trim();
  }

  if (params.limit !== undefined && params.limit !== "") {
    const n = parseInt(String(params.limit), 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: "limit must be a positive integer" };
    }
    out.limit = Math.min(2000, n);
  }

  if (params.offset !== undefined && params.offset !== "") {
    const n = parseInt(String(params.offset), 10);
    if (!Number.isFinite(n) || n < 0) {
      return { error: "offset must be a non-negative integer" };
    }
    out.offset = n;
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

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const params = Object.fromEntries(url.searchParams.entries());
  const v = parseVariancesQuery(params);
  if (v.error) return res.status(400).json({ error: v.error });

  const f = v.data;

  let query = admin
    .from("recon_variances")
    .select(
      "id, recon_run_id, source_table, source_id, source_tag, " +
        "tangerine_amount_cents, xoro_amount_cents, variance_amount_cents, " +
        "variance_percent, status, notes, created_at",
    )
    .eq("recon_run_id", f.recon_run_id)
    .order("status", { ascending: true })          // 'over' before 'within' alphabetically? No — order by abs(variance) desc instead.
    .order("created_at", { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  if (f.status)     query = query.eq("status", f.status);
  if (f.source_tag) query = query.eq("source_tag", f.source_tag);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const variances = data || [];
  return res.status(200).json({
    count: variances.length,
    limit: f.limit,
    offset: f.offset,
    variances,
  });
}
