// api/internal/recon/runs
//
// Tangerine P9-7 — list recon_runs filtered by domain + date window.
//
//   GET /api/internal/recon/runs?
//        domain=ap|ar|cash|gl|inventory   (optional)
//       &from=YYYY-MM-DD                  (optional, inclusive lower bound on run_date)
//       &to=YYYY-MM-DD                    (optional, inclusive upper bound on run_date)
//       &limit=200                        (optional, default 200, max 1000)
//       &offset=0                         (optional)
//
// Returns:
//   200 {
//     count, limit, offset,
//     runs: [ ...recon_runs rows... ]
//   }
//
// DateRangePresets-compatible — the from/to params accept the same
// YYYY-MM-DD shape the T7 component emits. Date comparisons are
// inclusive on both ends (run_date is a DATE column, not a timestamp).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const RECON_DOMAINS = ["ap", "ar", "cash", "gl", "inventory"];

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
 * Pure query-string validator. Exported for unit tests so the
 * domain/date/limit envelope logic can be tested without supabase.
 */
export function parseRunsQuery(params) {
  const out = {
    domain: null,
    from: null,
    to: null,
    limit: 200,
    offset: 0,
  };

  if (params.domain !== undefined && params.domain !== "") {
    const v = String(params.domain).trim().toLowerCase();
    if (!RECON_DOMAINS.includes(v)) {
      return {
        error:
          `domain "${v}" is not valid. ` +
          `Valid: ${RECON_DOMAINS.join(", ")}.`,
      };
    }
    out.domain = v;
  }

  if (params.from !== undefined && params.from !== "") {
    const v = String(params.from).trim();
    if (!DATE_RE.test(v)) {
      return { error: `from must be YYYY-MM-DD (got "${v}")` };
    }
    out.from = v;
  }

  if (params.to !== undefined && params.to !== "") {
    const v = String(params.to).trim();
    if (!DATE_RE.test(v)) {
      return { error: `to must be YYYY-MM-DD (got "${v}")` };
    }
    out.to = v;
  }

  if (out.from && out.to && out.from > out.to) {
    return { error: "from must be <= to" };
  }

  if (params.limit !== undefined && params.limit !== "") {
    const n = parseInt(String(params.limit), 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: "limit must be a positive integer" };
    }
    out.limit = Math.min(1000, n);
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
  const v = parseRunsQuery(params);
  if (v.error) return res.status(400).json({ error: v.error });

  const f = v.data;

  let query = admin
    .from("recon_runs")
    .select(
      "id, entity_id, domain, run_date, period_start, period_end, cadence, " +
        "status, started_at, completed_at, totals_jsonb, replay_of_id, " +
        "replay_reason, notes, created_at, updated_at",
    )
    .order("run_date", { ascending: false })
    .order("domain", { ascending: true })
    .range(f.offset, f.offset + f.limit - 1);

  if (f.domain) query = query.eq("domain", f.domain);
  if (f.from)   query = query.gte("run_date", f.from);
  if (f.to)     query = query.lte("run_date", f.to);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const runs = data || [];
  return res.status(200).json({
    count: runs.length,
    limit: f.limit,
    offset: f.offset,
    runs,
  });
}
