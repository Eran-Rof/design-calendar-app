// api/vendor/change-requests
//
// POST — vendor proposes an edit to a PO phase milestone. The request is
//        staged in tanda_milestone_change_requests with status='pending'
//        and a po_message is fired to the ROF reviewer. Nothing is
//        written to tanda_milestones directly — an internal user has to
//        approve/reject the request on the TandA side.
//
// body: {
//   po_id:      uuid (required),
//   phase_name: string (required, must be in the vendor's permitted list),
//   field_name: 'expected_date' | 'status' | 'status_date' | 'notes',
//   old_value:  string | null,
//   new_value:  string | null,
// }

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../_lib/vendor-auth.js";
import { notifyInternal } from "../../_lib/phase-notifications.js";

export const config = { maxDuration: 15 };

const ALLOWED_FIELDS = new Set(["expected_date", "status", "status_date", "notes"]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req, { requiredScope: "grid:write" });
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const { auth, finish } = authRes;
  const vendorId = auth.vendor_id;
  const send = (code, payload) => { finish?.(code); return res.status(code).json(payload); };

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }
  const { po_id, phase_name, field_name, old_value, new_value, po_line_key } = body || {};

  if (!po_id) return send(400, { error: "po_id is required" });
  if (!phase_name || typeof phase_name !== "string") return send(400, { error: "phase_name is required" });
  if (!field_name || !ALLOWED_FIELDS.has(field_name)) {
    return send(400, { error: `field_name must be one of: ${Array.from(ALLOWED_FIELDS).join(", ")}` });
  }

  // Verify the PO belongs to the caller's vendor.
  const { data: po } = await admin
    .from("tanda_pos").select("uuid_id, po_number, vendor_id")
    .eq("uuid_id", po_id).eq("vendor_id", vendorId).maybeSingle();
  if (!po) return send(403, { error: "PO not found or not yours" });

  // Check the vendor has permission to edit this phase.
  const { data: perm } = await admin
    .from("vendor_phase_permissions")
    .select("can_edit")
    .eq("vendor_id", vendorId)
    .eq("phase_name", phase_name)
    .maybeSingle();
  if (!perm?.can_edit) {
    return send(403, { error: `You don't have permission to edit "${phase_name}". Contact your Ring of Fire admin.` });
  }

  // Collapse: if a pending request already exists for the same
  // (vendor, po, phase, line, field), update its new_value rather than
  // inserting a second pending row. We preserve the ORIGINAL old_value
  // from the first request so the reviewer sees the true baseline
  // instead of an intermediate step the vendor has since superseded.
  const lineKeyNorm = po_line_key ? String(po_line_key) : null;
  let existingQ = admin
    .from("tanda_milestone_change_requests")
    .select("id, old_value")
    .eq("vendor_id", vendorId)
    .eq("po_id", po_id)
    .eq("phase_name", phase_name)
    .eq("field_name", field_name)
    .eq("status", "pending");
  existingQ = lineKeyNorm === null ? existingQ.is("po_line_key", null) : existingQ.eq("po_line_key", lineKeyNorm);
  const { data: existingMatch } = await existingQ.order("requested_at", { ascending: false }).limit(1).maybeSingle();

  let inserted;
  let insErr;
  if (existingMatch?.id) {
    ({ data: inserted, error: insErr } = await admin
      .from("tanda_milestone_change_requests")
      .update({
        new_value: new_value != null ? String(new_value) : null,
        requested_at: new Date().toISOString(),
        requested_by_vendor_user_id: auth.vendor_user_id || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingMatch.id)
      .select("*")
      .single());
  } else {
    ({ data: inserted, error: insErr } = await admin
      .from("tanda_milestone_change_requests")
      .insert({
        vendor_id: vendorId,
        po_id,
        po_number: po.po_number,
        phase_name,
        field_name,
        old_value: old_value != null ? String(old_value) : null,
        new_value: new_value != null ? String(new_value) : null,
        requested_by_vendor_user_id: auth.vendor_user_id || null,
        po_line_key: lineKeyNorm,
      })
      .select("*")
      .single());
  }
  if (insErr) return send(500, { error: insErr.message });

  // Fire a vendor-authored po_message so the internal thread lights up.
  if (auth.auth_id) {
    try {
      await admin.from("po_messages").insert({
        po_id,
        sender_type: "vendor",
        sender_auth_id: auth.auth_id,
        sender_name: "Vendor (auto-generated)",
        body: `🛠 Proposed change on ${po.po_number}: "${phase_name}"${po_line_key ? ` · line ${po_line_key}` : ""} → ${field_name} = ${new_value ?? "(cleared)"} (was ${old_value ?? "(empty)"}). Awaiting Ring of Fire review.`,
        read_by_vendor: true,
        read_by_internal: false,
      });
    } catch { /* non-blocking */ }
  }

  // Notify internal reviewers so their bell + email lights up. Skip
  // silently if the fan-out errors — the po_message + grid are the
  // authoritative record.
  try {
    await notifyInternal(admin, {
      event_type: "phase_change_proposed",
      title: `Phase change proposed · ${po.po_number}`,
      body: `"${phase_name}"${po_line_key ? ` (line-level)` : ""}: ${field_name} → ${new_value ?? "(cleared)"} (was ${old_value ?? "(empty)"}). Needs your review.`,
      link: "/rof/phase-reviews",
      metadata: { po_id, po_number: po.po_number, phase_name, field_name, po_line_key, request_id: inserted?.id },
    });
  } catch { /* non-blocking */ }

  return send(201, inserted);
}
