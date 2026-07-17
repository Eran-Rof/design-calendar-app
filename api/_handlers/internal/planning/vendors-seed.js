// api/internal/planning/vendors/seed
//
// "Seed from Tangerine vendors" — bulk create one ip_vendor_master row per
// Tangerine `vendors` row that isn't already represented, pre-linked
// (portal_vendor_id set). Idempotent: re-running creates nothing new because
// every Tangerine vendor now matches an existing planning vendor on
// portal_vendor_id. Reports "created N, skipped M existing".
//
// POST → { created, skipped, message, vendors: [...] }
// Permission: manage_integrations.
//
// Matching / dedupe / code-generation logic lives in
// api/_lib/seedPlanningVendors.js (pure, unit-tested); this handler only does
// IO + the insert.

import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "../../../_lib/ip-permissions.js";
import { planSeedVendors } from "../../../_lib/seedPlanningVendors.js";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

const VENDOR_SELECT = "id, vendor_code, name, country, default_lead_time_days, moq_units, active, portal_vendor_id, created_at, updated_at";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const perm = await checkPermission(req, "manage_integrations");
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const [{ data: tangerineVendors, error: tvErr }, { data: existingVendors, error: exErr }] = await Promise.all([
    admin.from("vendors").select("id, name, code").is("deleted_at", null).limit(10000),
    admin.from("ip_vendor_master").select("id, vendor_code, name, portal_vendor_id").limit(10000),
  ]);
  if (tvErr) return res.status(500).json({ error: `Tangerine vendor load failed: ${tvErr.message}` });
  if (exErr) return res.status(500).json({ error: `Planning vendor load failed: ${exErr.message}` });

  const { toCreate, summary } = planSeedVendors({
    tangerineVendors: tangerineVendors || [],
    existingVendors: existingVendors || [],
  });

  let inserted = [];
  if (toCreate.length) {
    const { data, error } = await admin.from("ip_vendor_master")
      .insert(toCreate.map((v) => ({ vendor_code: v.vendor_code, name: v.name, portal_vendor_id: v.portal_vendor_id })))
      .select(VENDOR_SELECT);
    if (error) return res.status(500).json({ error: `Seed insert failed: ${error.message}`, created: 0, skipped: summary.skipped });
    inserted = data || [];
  }

  return res.status(toCreate.length ? 201 : 200).json({
    created: inserted.length,
    skipped: summary.skipped,
    vendors: inserted,
    message: `Seeded ${inserted.length} planning vendor(s) from Tangerine; skipped ${summary.skipped} already represented.`,
  });
}
