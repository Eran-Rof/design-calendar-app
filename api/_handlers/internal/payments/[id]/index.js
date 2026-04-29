// api/internal/payments/:id
//
// GET — payment detail.
// PUT — status transition.
//   body: { action: 'processing'|'completed'|'failed'|'cancelled', reference?, metadata? }

import { createClient } from "@supabase/supabase-js";
import { nextStatus } from "../../../../_lib/payments.js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("payments");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing payment id" });

  if (req.method === "GET") {
    const { data } = await admin.from("payments")
      .select("*, vendor:vendors(id, name), invoice:invoices(id, invoice_number, total, currency)")
      .eq("id", id).maybeSingle();
    if (!data) return res.status(404).json({ error: "Payment not found" });
    // Redact internal-only metadata keys before returning. The full
    // FX plan / SCF refs are useful for debugging but shouldn't ride
    // out to every callsite; surface only the human-meaningful fields.
    const md = (data.metadata && typeof data.metadata === "object") ? data.metadata : {};
    const safeMetadata = {
      // Allowlist of keys a viewer is allowed to see.
      vendor_currency: md.vendor_currency ?? null,
      entity_currency: md.entity_currency ?? null,
      vendor_amount:   md.vendor_amount   ?? md.to_amount ?? null,
      fx_rate:         md.fx_rate         ?? null,
      fx_handling:     md.fx_handling     ?? null,
      fx_snapshot_at:  md.fx_snapshot_at  ?? null,
      reference:       md.reference       ?? null,
      // fee_amount / program_id / fx provider raw response intentionally
      // omitted — see the redaction rationale comment.
    };
    return res.status(200).json({ ...data, metadata: safeMetadata });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { action, reference, metadata } = body || {};
    if (!action) return res.status(400).json({ error: "action required" });

    const { data: payment } = await admin.from("payments").select("*").eq("id", id).maybeSingle();
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    let next;
    try { next = nextStatus(payment.status, action); }
    catch (err) { return res.status(409).json({ error: err?.message || String(err) }); }

    const nowIso = new Date().toISOString();
    const updates = { status: next, updated_at: nowIso };
    if (next === "completed") updates.completed_at = nowIso;
    if (reference !== undefined) updates.reference = reference;
    if (metadata  !== undefined) updates.metadata  = { ...(payment.metadata || {}), ...metadata };

    const { error } = await admin.from("payments").update(updates).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });

    // If this payment is linked to a discount offer, flip that offer to 'paid'.
    // Filter on status='accepted' so we don't accidentally resurrect an expired
    // or already-paid offer if the linked offer drifted out of state.
    if (next === "completed" && payment.metadata?.discount_offer_id) {
      await admin.from("dynamic_discount_offers")
        .update({ status: "paid", paid_at: nowIso, updated_at: nowIso })
        .eq("id", payment.metadata.discount_offer_id)
        .eq("status", "accepted");
    }

    return res.status(200).json({ ok: true, id, status: next });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
