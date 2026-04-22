// api/internal/rfqs/:id
//
// GET — RFQ detail with line items + invitations + quote summary.
// PUT — update RFQ header + line items. Only allowed while status='draft'.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const EDITABLE = ["title", "description", "category", "submission_deadline", "delivery_required_by", "estimated_quantity", "estimated_budget", "currency"];

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rfqs");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing rfq id" });

  if (req.method === "GET") {
    const [r, li, inv, qt] = await Promise.all([
      admin.from("rfqs").select("*, entity:entities(id, name, slug)").eq("id", id).maybeSingle(),
      admin.from("rfq_line_items").select("*").eq("rfq_id", id).order("line_index", { ascending: true }),
      admin.from("rfq_invitations").select("*, vendor:vendors(id, name)").eq("rfq_id", id),
      admin.from("rfq_quotes").select("id, vendor_id, status, total_price, lead_time_days, submitted_at").eq("rfq_id", id),
    ]);
    if (!r.data) return res.status(404).json({ error: "RFQ not found" });
    return res.status(200).json({
      rfq: r.data,
      line_items: li.data || [],
      invitations: inv.data || [],
      quotes: qt.data || [],
    });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

    const { data: existing } = await admin.from("rfqs").select("id, status").eq("id", id).maybeSingle();
    if (!existing) return res.status(404).json({ error: "RFQ not found" });
    if (existing.status !== "draft") return res.status(409).json({ error: `Cannot edit RFQ in status '${existing.status}' — only drafts are editable` });

    const updates = {};
    for (const f of EDITABLE) {
      if (body && Object.prototype.hasOwnProperty.call(body, f)) updates[f] = body[f];
    }
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error } = await admin.from("rfqs").update(updates).eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
    }

    if (Array.isArray(body?.line_items)) {
      await admin.from("rfq_line_items").delete().eq("rfq_id", id);
      const rows = body.line_items.map((li, idx) => ({
        rfq_id: id, line_index: idx + 1,
        description: String(li.description || "").trim(),
        quantity: Number(li.quantity) || 0,
        unit_of_measure: li.unit_of_measure || null,
        specifications: li.specifications || null,
      }));
      if (rows.length > 0) {
        const { error: liErr } = await admin.from("rfq_line_items").insert(rows);
        if (liErr) return res.status(500).json({ error: liErr.message });
      }
    }

    if (Array.isArray(body?.vendor_ids)) {
      const invites = body.vendor_ids.map((vid) => ({ rfq_id: id, vendor_id: vid, status: "invited" }));
      if (invites.length > 0) await admin.from("rfq_invitations").upsert(invites, { onConflict: "rfq_id,vendor_id" });
    }

    return res.status(200).json({ ok: true, id });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
