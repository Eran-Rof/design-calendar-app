// api/internal/recon/cutovers
//
// Tangerine P9-7 — list recon_cutover_signoffs (D8 audit trail).
//
//   GET /api/internal/recon/cutovers?
//        [domain=ap|ar|cash|gl|inventory]
//       &[source_tag=shopify|fba|walmart|faire|xoro_mirror|...]
//       &[limit=200&offset=0]
//
// Returns:
//   200 {
//     count, limit, offset,
//     cutovers: [ ...recon_cutover_signoffs rows... ]
//   }
//
// Read-only. The dashboard's "Cutover history" panel renders these.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { RECON_DOMAINS } from "./runs.js";

export const config = { maxDuration: 15 };

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
 * Pure validator. Exported for unit tests.
 */
export function parseCutoversQuery(params) {
  const out = {
    domain: null,
    source_tag: null,
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

  if (params.source_tag !== undefined && params.source_tag !== "") {
    out.source_tag = String(params.source_tag).trim();
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
  const v = parseCutoversQuery(params);
  if (v.error) return res.status(400).json({ error: v.error });

  const f = v.data;

  let query = admin
    .from("recon_cutover_signoffs")
    .select(
      "id, entity_id, domain, source_tag, clean_window_start, " +
        "clean_window_end, total_recons, signoff_employee_id, " +
        "signoff_at, notes",
    )
    .order("signoff_at", { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  if (f.domain)     query = query.eq("domain", f.domain);
  if (f.source_tag) query = query.eq("source_tag", f.source_tag);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const cutovers = data || [];
  return res.status(200).json({
    count: cutovers.length,
    limit: f.limit,
    offset: f.offset,
    cutovers,
  });
}
