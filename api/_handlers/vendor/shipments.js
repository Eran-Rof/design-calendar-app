// api/vendor/shipments.js
//
// POST — vendor submits a shipment / ASN (header + line items).
//   body: {
//     po_id: uuid (required — tanda_pos.uuid_id),
//     asn_number: string (required),
//     carrier?: string,
//     ship_date?: "YYYY-MM-DD",
//     estimated_delivery?: "YYYY-MM-DD",
//     number?: string, number_type?: "CT"|"BL"|"BK",
//     notes?: string,
//     line_items: [{ po_line_item_id, quantity_shipped, notes? }]
//   }
//
// Side effects:
//   - Inserts shipments row (workflow_status='submitted') + shipment_lines
//   - Fires asn_submitted notification to INTERNAL_SHIPMENT_EMAILS,
//     subject: '{vendor name} submitted ASN {asn_number}'

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../_lib/vendor-auth.js";
import { getInternalRecipients, resolveInternalRecipients } from "../../_lib/internal-recipients.js";

export const config = { maxDuration: 30 };

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

  const authResult = await authenticateVendor(admin, req, { requiredScope: "shipments:write" });
  if (!authResult.ok) return res.status(authResult.status).json({ error: authResult.error });
  const { auth, finish } = authResult;
  const caller = { vendor_id: auth.vendor_id, id: auth.vendor_user_id || null };
  const send = (code, body) => { finish?.(code); return res.status(code).json(body); };

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }

  const {
    po_id, asn_number, carrier, ship_via, ship_date, estimated_delivery,
    estimated_port_date,
    number, number_type, notes, line_items,
    packing_list_url, bl_document_url,
  } = body || {};

  if (!po_id) return send(400, { error: "po_id is required" });
  if (!asn_number || typeof asn_number !== "string" || !asn_number.trim()) return send(400, { error: "asn_number is required" });
  if (!Array.isArray(line_items) || line_items.length === 0) return send(400, { error: "At least one line_item is required" });
  if (number_type && !["CT", "BL", "BK"].includes(number_type)) return send(400, { error: "number_type must be CT, BL, or BK" });

  // Require at least one line with quantity_shipped > 0. Otherwise the
  // shipment header gets inserted with zero lines (orphan).
  const hasShippable = line_items.some((l) => (Number(l.quantity_shipped) || 0) > 0);
  if (!hasShippable) return send(400, { error: "At least one line_item must have quantity_shipped > 0" });

  // PO ownership check across BOTH sources: legacy Xoro (tanda_pos.uuid_id) and
  // Tangerine-native (purchase_orders.id). The po_id FK was dropped (migration
  // 20260896130000) so either id can be stored; we still verify the PO belongs
  // to the caller here.
  let po = null;
  {
    const { data: xpo } = await admin
      .from("tanda_pos").select("uuid_id, po_number, vendor_id")
      .eq("uuid_id", po_id).eq("vendor_id", caller.vendor_id).maybeSingle();
    if (xpo) {
      po = { po_number: xpo.po_number };
    } else {
      const { data: tpo } = await admin
        .from("purchase_orders").select("id, po_number, vendor_id")
        .eq("id", po_id).eq("vendor_id", caller.vendor_id).maybeSingle();
      if (tpo) po = { po_number: tpo.po_number };
    }
  }
  if (!po) return send(403, { error: "PO not found or not yours" });

  // Path-injection guard — both URLs must live under the caller's folder
  // when supplied. Without this, a vendor could attach another vendor's
  // packing list / BL doc to their own shipment.
  if (packing_list_url && (typeof packing_list_url !== "string" || !packing_list_url.startsWith(`${caller.vendor_id}/`))) {
    return send(403, { error: "packing_list_url must be under the caller's vendor folder" });
  }
  if (bl_document_url && (typeof bl_document_url !== "string" || !bl_document_url.startsWith(`${caller.vendor_id}/`))) {
    return send(403, { error: "bl_document_url must be under the caller's vendor folder" });
  }

  const { data: ship, error: shipErr } = await admin.from("shipments").insert({
    vendor_id: caller.vendor_id,
    vendor_user_id: caller.id,
    po_id,
    po_number: po.po_number,
    asn_number: asn_number.trim(),
    number: number ? String(number).trim().toUpperCase() : null,
    number_type: number_type || null,
    carrier: carrier || null,
    ship_via: ship_via || null,
    ship_date: ship_date || null,
    estimated_delivery: estimated_delivery || null,
    eta: estimated_port_date || null,
    workflow_status: "submitted",
    notes: notes ? String(notes).trim() : null,
    packing_list_url: packing_list_url || null,
    bl_document_url: bl_document_url || null,
  }).select("*").single();
  if (shipErr) {
    if (shipErr.code === "23505") return send(409, { error: "An ASN with this reference already exists for your vendor" });
    return send(500, { error: shipErr.message });
  }

  const lineRows = line_items.map((l) => ({
    shipment_id: ship.id,
    po_line_item_id: l.po_line_item_id || null,
    quantity_shipped: Number(l.quantity_shipped) || 0,
    notes: l.notes ? String(l.notes).trim() : null,
  })).filter((l) => l.quantity_shipped > 0);
  if (lineRows.length > 0) {
    const { error: liErr } = await admin.from("shipment_lines").insert(lineRows);
    if (liErr) return send(201, { ...ship, line_items_error: liErr.message });
  }

  // Bridge to the native in-transit OVERLAY: creating this ASN marks the
  // matching native PO "in transit" via a po_shipments record (source=
  // 'vendor_asn'), so the Tangerine PO grid shows the ✈ chip + ETA. Best-effort
  // and fully try-wrapped — the ASN itself already succeeded, so a missing table
  // (pre-migration) or any mapping gap must NEVER fail the vendor's submit.
  try {
    const { data: nativePo } = await admin
      .from("purchase_orders").select("id").eq("po_number", po.po_number).limit(1).maybeSingle();
    if (nativePo?.id) {
      const { data: overlay } = await admin.from("po_shipments").insert({
        purchase_order_id: nativePo.id,
        source: "vendor_asn",
        status: "in_transit",
        carrier: carrier || null,
        tracking_number: number ? String(number).trim().toUpperCase() : null,
        asn_ref: asn_number.trim(),
        shipped_date: ship_date || null,
        eta: estimated_delivery || null,
        notes: notes ? String(notes).trim() : null,
      }).select("id").single();
      if (overlay?.id) {
        // Map only line_items whose po_line_item_id is a NATIVE line of this PO
        // (native-PO submits carry purchase_order_lines ids directly). Xoro-line
        // ids won't match → header-only overlay, which still lights the chip.
        const lineIds = [...new Set((line_items || []).map((l) => l.po_line_item_id).filter(Boolean))];
        if (lineIds.length) {
          const { data: nativeLines } = await admin
            .from("purchase_order_lines").select("id").eq("purchase_order_id", nativePo.id).in("id", lineIds);
          const valid = new Set((nativeLines || []).map((r) => r.id));
          const ovLines = (line_items || [])
            .filter((l) => valid.has(l.po_line_item_id) && (Number(l.quantity_shipped) || 0) > 0)
            .map((l) => ({ shipment_id: overlay.id, purchase_order_line_id: l.po_line_item_id, qty_in_transit: Number(l.quantity_shipped) || 0 }));
          if (ovLines.length) await admin.from("po_shipment_lines").insert(ovLines);
        }
      }
    }
  } catch { /* overlay bridge is best-effort — never block the ASN */ }

  // Internal notification
  try {
    const { emails } = await resolveInternalRecipients(admin, "shipment", { event: "asn_submitted" });
    if (emails.length > 0) {
      const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
      const vendorName = vendor?.name || "A vendor";
      const origin = `https://${req.headers.host}`;
      await Promise.all(emails.map((email) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "asn_submitted",
            title: `${vendorName} submitted ASN ${asn_number.trim()}`,
            body: `PO ${po.po_number}${carrier ? ` · via ${carrier}` : ""}${ship_date ? ` · shipping ${ship_date}` : ""}. Open TandA to review.`,
            link: "/",
            metadata: { shipment_id: ship.id, vendor_id: caller.vendor_id, po_number: po.po_number, asn_number: asn_number.trim() },
            recipient: { internal_id: "logistics_team", email },
            dedupe_key: `asn_submitted_${ship.id}_${email}`,
            email: true,
          }),
        }).catch(() => {})
      ));
    }
  } catch { /* non-blocking */ }

  return send(201, ship);
}
