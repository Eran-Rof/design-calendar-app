// api/internal/planning/link-planning-vendor  (h606)
//
// M31 direction-A helper — link a planning vendor (ip_vendor_master) to a
// Tangerine vendor (vendors) by setting ip_vendor_master.portal_vendor_id.
// This is the one-click resolver behind the buy-plan→PO "vendor not linked"
// skip: the operator picks one of the match suggestions and POSTs here.
//
// POST { planning_vendor_id, tangerine_vendor_id }  (x-user-email header;
//        permission: manage_integrations)
//
// Validates both rows exist, then sets the link. Idempotent.

import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "../../../_lib/ip-permissions.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const perm = await checkPermission(req, "manage_integrations");
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const planningVendorId = body.planning_vendor_id;
  const tangerineVendorId = body.tangerine_vendor_id;
  if (!planningVendorId || !tangerineVendorId) {
    return res.status(400).json({ error: "planning_vendor_id and tangerine_vendor_id required" });
  }

  const { data: vm } = await admin.from("ip_vendor_master").select("id, name, vendor_code").eq("id", planningVendorId).maybeSingle();
  if (!vm) return res.status(404).json({ error: "Planning vendor not found" });
  const { data: tv } = await admin.from("vendors").select("id, name, code").eq("id", tangerineVendorId).maybeSingle();
  if (!tv) return res.status(404).json({ error: "Tangerine vendor not found" });

  const { error: uErr } = await admin.from("ip_vendor_master")
    .update({ portal_vendor_id: tangerineVendorId, updated_at: new Date().toISOString() })
    .eq("id", planningVendorId);
  if (uErr) return res.status(500).json({ error: `Link failed: ${uErr.message}` });

  return res.status(200).json({
    ok: true,
    planning_vendor: { id: vm.id, name: vm.name, vendor_code: vm.vendor_code },
    tangerine_vendor: { id: tv.id, name: tv.name, code: tv.code },
    message: `Linked planning vendor "${vm.vendor_code || vm.name}" → Tangerine vendor "${tv.name}".`,
  });
}
