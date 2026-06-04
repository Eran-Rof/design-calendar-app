// api/internal/rfqs/:id/messages
//
// RFQ-linked messaging, internal side. Lets the buyer reviewing an RFQ see
// vendor messages and reply — the RFQ-stage analogue of Tanda → Messages.
//
// GET  — full thread for this RFQ (asc order).
//        Side-effect: marks incoming (sender_type='vendor') as read_by_internal.
// POST — create a new internal-originated message.
//        body: { body, sender_name?, sender_internal_id? }
//        Fires an rfq_message notification to the invited vendor(s)' primary user.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 30 };

function getRfqId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rfqs");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const gate = authenticateInternalCaller(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const rfqId = getRfqId(req);
  if (!rfqId) return res.status(400).json({ error: "Missing rfq id" });

  const { data: rfq } = await admin.from("rfqs").select("id, title").eq("id", rfqId).maybeSingle();
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });

  if (req.method === "GET") {
    const { data: messages, error } = await admin
      .from("rfq_messages")
      .select("id, rfq_id, sender_type, sender_name, body, read_by_vendor, read_by_internal, created_at")
      .eq("rfq_id", rfqId)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const toMark = (messages || [])
      .filter((m) => m.sender_type === "vendor" && !m.read_by_internal)
      .map((m) => m.id);
    if (toMark.length) {
      await admin.from("rfq_messages").update({ read_by_internal: true }).in("id", toMark);
    }

    return res.status(200).json(messages || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const messageBody = body?.body;
    if (!messageBody || typeof messageBody !== "string" || !messageBody.trim()) {
      return res.status(400).json({ error: "body is required" });
    }
    const senderInternalId = (body?.sender_internal_id && String(body.sender_internal_id).trim()) || "rfq_thread";
    const senderName = (body?.sender_name && String(body.sender_name).trim()) || "Ring of Fire";

    const { data: msg, error: msgErr } = await admin.from("rfq_messages").insert({
      rfq_id: rfqId,
      sender_type: "internal",
      sender_internal_id: senderInternalId,
      sender_name: senderName,
      body: messageBody.trim(),
      read_by_vendor: false,
      read_by_internal: true,
    }).select("*").single();
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    // Notify the invited vendor(s)' primary contact (send-notification resolves
    // the vendor's primary vendor_user → email). Non-blocking.
    try {
      const { data: invites } = await admin
        .from("rfq_invitations")
        .select("vendor_id")
        .eq("rfq_id", rfqId);
      const vendorIds = [...new Set((invites || []).map((i) => i.vendor_id).filter(Boolean))];
      if (vendorIds.length > 0) {
        const origin = `https://${req.headers.host}`;
        await Promise.all(vendorIds.map((vendorId) =>
          fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "rfq_message",
              title: `New message on RFQ ${rfq.title || ""}`.trim(),
              body: messageBody.trim().slice(0, 200),
              link: "/vendor/rfqs",
              metadata: { rfq_id: rfqId, vendor_id: vendorId, message_id: msg.id },
              recipient: { vendor_id: vendorId },
              dedupe_key: `rfq_message_${msg.id}_${vendorId}`,
              email: true,
            }),
          }).catch(() => {})
        ));
      }
    } catch { /* non-blocking */ }

    return res.status(201).json(msg);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
