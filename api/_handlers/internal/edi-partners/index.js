// api/internal/edi-partners  (h620)
//
// P22 / M14 — surface + manage EDI trading partners. An EDI-enabled vendor is
// an `erp_integrations` row (status='active', config.partner_id set) — that's
// exactly what the inbound/outbound EDI pipeline (api/_lib/edi/*) resolves
// against. This endpoint lists them with vendor names and lets the operator
// enable EDI for a vendor (set the partner_id / EDI sender ID).
//
//   GET  /api/internal/edi-partners                  → integrations w/ vendor + partner_id
//   POST /api/internal/edi-partners                  → enable / update EDI for a vendor
//        body { vendor_id, partner_id, transport?, status?, notes? }
//
// type='custom' (the erp_integrations type enum has no 'edi'); config.kind='edi'
// tags it. The EDI engine keys off vendor_id + status='active' + config.partner_id.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("erp_integrations")
      .select("id, vendor_id, type, status, config, last_sync_at, last_sync_status, last_sync_error, updated_at, vendors(name, code)")
      .order("updated_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    // Surface only EDI partners (those with a partner_id) + flatten config.
    const partners = (data || []).map((r) => ({
      id: r.id, vendor_id: r.vendor_id,
      vendor_name: r.vendors?.name || null, vendor_code: r.vendors?.code || null,
      partner_id: r.config?.partner_id || r.config?.edi_id || r.config?.isa_id || null,
      transport: r.config?.transport || null,
      status: r.status, last_sync_at: r.last_sync_at, last_sync_status: r.last_sync_status, last_sync_error: r.last_sync_error,
    })).filter((p) => p.partner_id);
    return res.status(200).json({ partners });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    if (!body.vendor_id) return res.status(400).json({ error: "vendor_id required" });
    if (!body.partner_id) return res.status(400).json({ error: "partner_id required (the partner's EDI sender / ISA ID)" });

    const { data: existing } = await admin.from("erp_integrations").select("id, config").eq("vendor_id", body.vendor_id).maybeSingle();
    const cfg = { ...(existing?.config || {}), kind: "edi", partner_id: String(body.partner_id).trim() };
    if (body.transport) cfg.transport = body.transport;
    if (body.notes !== undefined) cfg.notes = body.notes;
    const row = { vendor_id: body.vendor_id, type: "custom", status: body.status || "active", config: cfg, updated_at: new Date().toISOString() };

    if (existing) {
      const { error } = await admin.from("erp_integrations").update(row).eq("id", existing.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ id: existing.id, message: "EDI partner updated." });
    }
    const { data, error } = await admin.from("erp_integrations").insert(row).select("id").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id: data.id, message: "EDI enabled for vendor." });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
