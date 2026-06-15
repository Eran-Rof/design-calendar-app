// api/internal/costing/search/styles
// GET ?q=<text>&entity_id=<uuid>&limit=<int>
//
// When `limit` is "all" OR larger than 1000, paginate through
// style_master in 1000-row chunks (PostgREST silently caps each
// request at 1000 — see project_postgrest_1000_row_cap memory). The
// picker preload calls with limit="all" to get every active style;
// type-ahead callers pass a small numeric limit (default 50) and skip
// pagination.
//
// entity_id filter is OPT-IN (only applied when explicitly passed). The
// picker doesn't send it because most costing operators source styles
// from across entities (planning/design vs. AR), same as the vendor and
// color pickers. Service-role bypasses RLS so the cross-entity read is
// safe at the API layer.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 20 };

const POSTGREST_PAGE = 1000;     // PostgREST hard cap per request
const HARD_CEILING   = 50000;    // absolute safety cap on `limit=all`

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = (url.searchParams.get("q") || "").trim();
  const entityId = url.searchParams.get("entity_id");
  const limitParam = (url.searchParams.get("limit") || "50").trim().toLowerCase();
  const isAll = limitParam === "all";
  const limitNum = isAll ? HARD_CEILING : Math.min(parseInt(limitParam, 10) || 50, HARD_CEILING);

  // base_fabric is resolved from the authoritative FK (base_fabric_code_id →
  // fabric_codes.code) so the costing line seeds the SAME fabric shown in Style
  // Master; the legacy free-text column is only a fallback for un-migrated rows.
  const cols = "id, entity_id, style_code, style_name, description, gender_code, category_id, season, base_fabric_legacy, base_fabric_ref:base_fabric_code_id ( code, name ), lifecycle_status";
  const buildQuery = (from, to) => {
    let qy = admin.from("style_master")
      .select(cols)
      .is("deleted_at", null)
      .range(from, to)
      .order("style_code", { ascending: true });
    if (entityId) qy = qy.eq("entity_id", entityId);
    if (q) {
      const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
      qy = qy.or(`style_code.ilike.${like},description.ilike.${like},style_name.ilike.${like}`);
    }
    return qy;
  };

  // Paginate through 1000-row windows until we hit `limit` or no more rows.
  const rows = [];
  let offset = 0;
  while (offset < limitNum) {
    const pageSize = Math.min(POSTGREST_PAGE, limitNum - offset);
    const to = offset + pageSize - 1;
    const { data, error } = await buildQuery(offset, to);
    if (error) return res.status(500).json({ error: error.message });
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break; // exhausted
    offset += batch.length;
  }

  // Flatten the fabric FK join into the legacy `base_fabric` string the client
  // expects (the costing line stores a fabric CODE). Prefer the FK code, fall
  // back to the legacy free-text for styles not yet migrated to the FK.
  const mapped = rows.map((r) => {
    const ref = r.base_fabric_ref;
    const base_fabric = (ref && (ref.code || ref.name)) || r.base_fabric_legacy || null;
    // Drop the join helpers; surface a clean `base_fabric` string.
    const { base_fabric_ref, base_fabric_legacy, ...rest } = r;
    return { ...rest, base_fabric };
  });

  return res.status(200).json({ rows: mapped });
}
