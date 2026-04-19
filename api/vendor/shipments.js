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
//   - Fires asn_submitted notification to INTERNAL_SHIPMENT_EMAILS
//     (falls back to INTERNAL_COMPLIANCE_EMAILS), subject:
//     '{vendor name} submitted ASN {asn_number}'

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin
      .from("vendor_users")
      .select("id, vendor_id, display_name")
      .eq("auth_id", data.user.id)
      .maybeSingle();
    if (!vu) return null;
    return { ...vu, auth_id: data.user.id, email: data.user.email };
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const {
    po_id, asn_number, carrier, ship_date, estimated_delivery,
    number, number_type, notes, line_items,
  } = body || {};

  if (!po_id) return res.status(400).json({ error: "po_id is required" });
  if (!asn_number || typeof asn_number !== "string" || !asn_number.trim()) return res.status(400).json({ error: "asn_number is required" });
  if (!Array.isArray(line_items) || line_items.length === 0) return res.status(400).json({ error: "At least one line_item is required" });
  if (number_type && !["CT", "BL", "BK"].includes(number_type)) return res.status(400).json({ error: "number_type must be CT, BL, or BK" });

  const { data: po } = await admin
    .from("tanda_pos").select("uuid_id, po_number, vendor_id")
    .eq("uuid_id", po_id).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!po) return res.status(403).json({ error: "PO not found or not yours" });

  const { data: ship, error: shipErr } = await admin.from("shipments").insert({
    vendor_id: caller.vendor_id,
    vendor_user_id: caller.id,
    po_id,
    po_number: po.po_number,
    asn_number: asn_number.trim(),
    number: number ? String(number).trim().toUpperCase() : null,
    number_type: number_type || null,
    carrier: carrier || null,
    ship_date: ship_date || null,
    estimated_delivery: estimated_delivery || null,
    workflow_status: "submitted",
    notes: notes ? String(notes).trim() : null,
  }).select("*").single();
  if (shipErr) {
    if (shipErr.code === "23505") return res.status(409).json({ error: "An ASN with this reference already exists for your vendor" });
    return res.status(500).json({ error: shipErr.message });
  }

  const lineRows = line_items.map((l) => ({
    shipment_id: ship.id,
    po_line_item_id: l.po_line_item_id || null,
    quantity_shipped: Number(l.quantity_shipped) || 0,
    notes: l.notes ? String(l.notes).trim() : null,
  })).filter((l) => l.quantity_shipped > 0);
  if (lineRows.length > 0) {
    const { error: liErr } = await admin.from("shipment_lines").insert(lineRows);
    if (liErr) return res.status(201).json({ ...ship, line_items_error: liErr.message });
  }

  // Internal notification
  try {
    const emails = (process.env.INTERNAL_SHIPMENT_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
      .split(",").map((e) => e.trim()).filter(Boolean);
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

  return res.status(201).json(ship);
}
