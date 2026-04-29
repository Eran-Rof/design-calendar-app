// api/internal/disputes/:id/messages
//
// POST — add an internal message to an existing dispute thread.
//   body: { body, sender_internal_id, sender_name }
// Fires new_dispute_message notification to the vendor (digest-aware).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const msgIdx = parts.lastIndexOf("messages");
  return msgIdx > 0 ? parts[msgIdx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const disputeId = getId(req);
  if (!disputeId) return res.status(400).json({ error: "Missing dispute id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { body: messageBody, sender_internal_id, sender_name } = body || {};
  if (!messageBody || !String(messageBody).trim()) return res.status(400).json({ error: "body is required" });
  if (!sender_internal_id || !sender_name) return res.status(400).json({ error: "sender_internal_id and sender_name are required" });

  const { data: dispute } = await admin
    .from("disputes").select("id, vendor_id, subject").eq("id", disputeId).maybeSingle();
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });

  const { data: msg, error: mErr } = await admin.from("dispute_messages").insert({
    dispute_id: disputeId,
    sender_type: "internal",
    sender_internal_id,
    sender_name,
    body: String(messageBody).trim(),
  }).select("*").single();
  if (mErr) return res.status(500).json({ error: mErr.message });

  await admin.from("disputes").update({
    last_viewed_by_internal_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", disputeId);

  // Vendor notification — send-notification handles the >3/hr digest
  // threshold via notification_digest_pending. Caller always passes
  // email:true; the dispatcher decides whether to send-now or queue.
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "new_dispute_message",
        title: `New message on dispute: ${dispute.subject}`,
        body: String(messageBody).trim().slice(0, 300),
        link: "/vendor/disputes",
        metadata: { dispute_id: disputeId, vendor_id: dispute.vendor_id },
        recipient: { vendor_id: dispute.vendor_id },
        dedupe_key: `dispute_msg_${msg.id}_vendor`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(201).json(msg);
}
