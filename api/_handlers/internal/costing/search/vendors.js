// api/internal/costing/search/vendors
// GET ?q=<text>&limit=<int>  → up to N active vendors (default 25, max 500)
//
// Unions two sources so the costing dropdown sees every vendor the
// operator has in either system:
//
//   1. `vendors`           — AR/AP portal master (Tanda PO origination,
//                            invoices, three-way match). Often sparse
//                            until POs start flowing.
//   2. `ip_vendor_master`  — Planning-side master (populated by the Xoro
//                            nightly sync from item sourcing history).
//                            Includes factories that never get a portal
//                            login, so it's the broader list on most
//                            entities.
//
// Dedup: a vendor present in both is merged on `code` (case-insensitive).
// `vendors.id` wins as the canonical id when available — that's what the
// downstream costing_line_vendors / RFQ flows expect.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
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
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "25", 10) || 25, 500);
  const like = q ? `%${q.replace(/[%_]/g, "\\$&")}%` : null;

  // Source A — portal vendors (operational). Active = status='active'.
  let vendorsQuery = admin.from("vendors")
    .select("id, code, legal_name, country, default_currency, status")
    .eq("status", "active")
    .limit(limit);
  if (like) vendorsQuery = vendorsQuery.or(`legal_name.ilike.${like},code.ilike.${like}`);
  vendorsQuery = vendorsQuery.order("legal_name", { ascending: true });

  // Source B — planning vendors. Active = active=true. Includes
  // portal_vendor_id so we can dedup against source A by the FK first
  // (falls back to code-match below for rows that don't have the link).
  let planningQuery = admin.from("ip_vendor_master")
    .select("id, vendor_code, name, country, active, portal_vendor_id")
    .eq("active", true)
    .limit(limit);
  if (like) planningQuery = planningQuery.or(`name.ilike.${like},vendor_code.ilike.${like}`);
  planningQuery = planningQuery.order("name", { ascending: true });

  const [a, b] = await Promise.all([vendorsQuery, planningQuery]);
  if (a.error) return res.status(500).json({ error: a.error.message });
  if (b.error) return res.status(500).json({ error: b.error.message });

  const portalRows = a.data || [];
  const planningRows = b.data || [];

  // Dedup map keyed on lowercase code. Portal vendors win — they carry the
  // canonical id costing_line_vendors.vendor_id expects (FK to vendors.id).
  const out = new Map();
  for (const v of portalRows) {
    const key = (v.code || "").toLowerCase().trim() || `__pid_${v.id}`;
    out.set(key, {
      id: v.id,
      code: v.code,
      legal_name: v.legal_name,
      country: v.country,
      default_currency: v.default_currency,
      status: v.status,
      source: "portal",
    });
  }
  for (const v of planningRows) {
    // Planning-only rows surface to the dropdown so the operator sees the
    // full vendor universe (most factories live only in ip_vendor_master,
    // populated by the Xoro nightly sync). On pick, the client calls
    // /api/internal/costing/add-vendor with the planning row's name+code
    // to materialize a portal vendor first — costing_line_vendors.vendor_id
    // requires a vendors(id) FK so we can't insert with a planning id.
    if (v.portal_vendor_id) continue; // already represented under the portal row
    const key = (v.vendor_code || "").toLowerCase().trim() || `__pid_${v.id}`;
    if (out.has(key)) continue;
    out.set(key, {
      id: v.id, // ip_vendor_master.id — flagged via source='planning'
      code: v.vendor_code,
      legal_name: v.name,
      country: v.country,
      default_currency: null,
      status: "active",
      source: "planning",
    });
  }

  // Sort the merged list alphabetically by legal_name → code.
  const rows = Array.from(out.values())
    .sort((x, y) => {
      const nx = (x.legal_name || x.code || "").toLowerCase();
      const ny = (y.legal_name || y.code || "").toLowerCase();
      return nx.localeCompare(ny);
    })
    .slice(0, limit);

  return res.status(200).json({ rows });
}
