// api/internal/planning/vendors/tangerine-options
//
// Lightweight option source for the "Link to Tangerine" picker on the
// /planning/vendors screen. Returns active Tangerine `vendors` (id, name,
// code) — the same table + fields buy-plan-to-po matches planning vendors
// against. Read-only; separate from the main vendors CRUD so the picker can
// load options without pulling the whole planning master.
//
// GET → { options: [{ id, name, code }] }
// Permission: manage_integrations.

import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "../../../_lib/ip-permissions.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const perm = await checkPermission(req, "manage_integrations");
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin.from("vendors")
    .select("id, name, code").is("deleted_at", null).order("name", { ascending: true }).limit(10000);
  if (error) return res.status(500).json({ error: `Vendor options failed: ${error.message}` });

  return res.status(200).json({ options: (data || []).map((v) => ({ id: v.id, name: v.name, code: v.code })) });
}
