// api/internal/rfqs
//
// GET — list RFQs for an entity.
//   ?entity_id=<uuid> (or X-Entity-ID)   default: all entities
//   ?status=draft|published|closed|awarded
//   ?category=<text>
// Each row includes quote_count.
//
// POST — create RFQ + line items + invitations.
//   body: {
//     entity_id, title, description?, category?,
//     submission_deadline?, delivery_required_by?,
//     estimated_quantity?, estimated_budget?, currency?,
//     line_items: [{ description, quantity, unit_of_measure?, specifications? }],
//     vendor_ids: [uuid, ...],
//     status?: 'draft' | 'published' (default 'draft'),
//     created_by?: string
//   }
// If status=published, invitations are sent immediately (rfq_invited).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 30 };

async function inviteVendors(admin, origin, rfq, lineItemCount) {
  const { data: invitations } = await admin
    .from("rfq_invitations")
    .select("vendor_id, vendor:vendors(id, name)")
    .eq("rfq_id", rfq.id)
    .eq("status", "invited");
  for (const inv of invitations || []) {
    try {
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "rfq_invited",
          title: `New RFQ: ${rfq.title}`,
          body: `You're invited to quote on ${rfq.title}. ${lineItemCount} line item${lineItemCount === 1 ? "" : "s"}${rfq.submission_deadline ? ` · deadline ${rfq.submission_deadline.slice(0, 10)}` : ""}.`,
          link: "/vendor/rfqs",
          metadata: { rfq_id: rfq.id, vendor_id: inv.vendor_id },
          recipient: { vendor_id: inv.vendor_id },
          dedupe_key: `rfq_invited_${rfq.id}_${inv.vendor_id}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* swallow */ }
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
    const status = url.searchParams.get("status");
    const category = url.searchParams.get("category");

    let q = admin.from("rfqs").select("*, entity:entities(id, name, slug)");
    if (entityId) q = q.eq("entity_id", entityId);
    if (status)   q = q.eq("status", status);
    if (category) q = q.eq("category", category);
    const { data: rfqs, error } = await q.order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Quote counts per RFQ
    const ids = (rfqs || []).map((r) => r.id);
    const counts = new Map();
    if (ids.length > 0) {
      const { data: quoteCounts } = await admin.from("rfq_quotes").select("rfq_id, status").in("rfq_id", ids);
      for (const q of quoteCounts || []) {
        const prev = counts.get(q.rfq_id) || { total: 0, submitted: 0 };
        prev.total++;
        if (q.status === "submitted") prev.submitted++;
        counts.set(q.rfq_id, prev);
      }
    }

    return res.status(200).json((rfqs || []).map((r) => ({
      ...r,
      quote_count: counts.get(r.id)?.total || 0,
      submitted_count: counts.get(r.id)?.submitted || 0,
    })));
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const {
      entity_id, title, description, category,
      submission_deadline, delivery_required_by,
      estimated_quantity, estimated_budget, currency,
      line_items = [], vendor_ids = [],
      status = "draft", created_by,
    } = body || {};

    if (!entity_id) return res.status(400).json({ error: "entity_id is required" });
    if (!title || !String(title).trim()) return res.status(400).json({ error: "title is required" });
    if (!["draft", "published"].includes(status)) return res.status(400).json({ error: "status must be draft or published" });
    if (!Array.isArray(line_items) || line_items.length === 0) return res.status(400).json({ error: "line_items must be non-empty" });

    // Insert RFQ header
    const { data: rfq, error } = await admin.from("rfqs").insert({
      entity_id,
      title: String(title).trim(),
      description: description || null,
      category: category || null,
      submission_deadline: submission_deadline || null,
      delivery_required_by: delivery_required_by || null,
      estimated_quantity: estimated_quantity || null,
      estimated_budget: estimated_budget || null,
      currency: (currency || "USD").toUpperCase(),
      status,
      created_by: created_by || null,
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });

    // Insert line items
    const lineRows = line_items.map((li, idx) => ({
      rfq_id: rfq.id,
      line_index: idx + 1,
      description: String(li.description || "").trim(),
      quantity: Number(li.quantity) || 0,
      unit_of_measure: li.unit_of_measure || null,
      specifications: li.specifications || null,
    }));
    await admin.from("rfq_line_items").insert(lineRows);

    // Insert invitations
    if (vendor_ids.length > 0) {
      const invites = vendor_ids.map((vid) => ({ rfq_id: rfq.id, vendor_id: vid, status: "invited" }));
      await admin.from("rfq_invitations").upsert(invites, { onConflict: "rfq_id,vendor_id" });
    }

    // Send invitations if published
    if (status === "published" && vendor_ids.length > 0) {
      const origin = `https://${req.headers.host}`;
      await inviteVendors(admin, origin, rfq, lineRows.length);
    }

    return res.status(201).json({ ...rfq, line_items: lineRows, invited_count: vendor_ids.length });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
