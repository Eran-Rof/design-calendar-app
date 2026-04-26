// api/vendor/shipments/:id
//
// PATCH — vendor edits a shipment they submitted. Only allowed while
//         workflow_status === 'submitted'. Once the ASN is accepted or
//         the carrier starts pushing live updates, edits must go
//         through a Ring of Fire reviewer.
//
// body (all fields optional — only provided keys are updated):
//   asn_number, carrier, ship_via, ship_date, estimated_delivery,
//   estimated_port_date, number, number_type, notes,
//   packing_list_url, bl_document_url

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";

export const config = { maxDuration: 15 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("shipments");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PATCH") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req, { requiredScope: "shipments:write" });
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const { auth, finish } = authRes;
  const vendorId = auth.vendor_id;
  const send = (code, payload) => { finish?.(code); return res.status(code).json(payload); };

  const shipmentId = getId(req);
  if (!shipmentId) return send(400, { error: "Shipment id missing from path" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }

  const {
    asn_number, carrier, ship_via, ship_date, estimated_delivery,
    estimated_port_date, number, number_type, notes,
    packing_list_url, bl_document_url,
  } = body || {};

  if (number_type !== undefined && number_type !== null && !["CT", "BL", "BK"].includes(number_type)) {
    return send(400, { error: "number_type must be CT, BL, or BK" });
  }

  const { data: current, error: fetchErr } = await admin
    .from("shipments").select("id, vendor_id, workflow_status").eq("id", shipmentId).maybeSingle();
  if (fetchErr) return send(500, { error: fetchErr.message });
  if (!current || current.vendor_id !== vendorId) return send(403, { error: "Shipment not found or not yours" });
  if (current.workflow_status !== "submitted") {
    return send(409, { error: `Cannot edit shipment in status "${current.workflow_status}" — contact your Ring of Fire reviewer for changes.` });
  }

  const patch = { updated_at: new Date().toISOString() };
  if (asn_number !== undefined) patch.asn_number = asn_number ? String(asn_number).trim() : null;
  if (carrier !== undefined) patch.carrier = carrier || null;
  if (ship_via !== undefined) patch.ship_via = ship_via || null;
  if (ship_date !== undefined) patch.ship_date = ship_date || null;
  if (estimated_delivery !== undefined) patch.estimated_delivery = estimated_delivery || null;
  if (estimated_port_date !== undefined) patch.eta = estimated_port_date || null;
  if (number !== undefined) patch.number = number ? String(number).trim().toUpperCase() : null;
  if (number_type !== undefined) patch.number_type = number_type || null;
  if (notes !== undefined) patch.notes = notes ? String(notes).trim() : null;
  // Path-injection guard — both URLs must live under the caller's folder
  // when supplied. Without this, a vendor could attach another vendor's
  // packing list / BL doc to their own shipment.
  if (packing_list_url !== undefined) {
    if (packing_list_url && (typeof packing_list_url !== "string" || !packing_list_url.startsWith(`${vendorId}/`))) {
      return send(403, { error: "packing_list_url must be under the caller's vendor folder" });
    }
    patch.packing_list_url = packing_list_url || null;
  }
  if (bl_document_url !== undefined) {
    if (bl_document_url && (typeof bl_document_url !== "string" || !bl_document_url.startsWith(`${vendorId}/`))) {
      return send(403, { error: "bl_document_url must be under the caller's vendor folder" });
    }
    patch.bl_document_url = bl_document_url || null;
  }

  if (Object.keys(patch).length > 1) {
    // Filter on vendor_id too — defense in depth in case the row's owner
    // changed between the read above and the update below.
    const { error: upErr } = await admin.from("shipments").update(patch).eq("id", shipmentId).eq("vendor_id", vendorId);
    if (upErr) {
      if (upErr.code === "23505") return send(409, { error: "An ASN with this reference already exists for your vendor" });
      return send(500, { error: upErr.message });
    }
  }

  const { data: updated } = await admin.from("shipments").select("*").eq("id", shipmentId).maybeSingle();
  return send(200, updated);
}
