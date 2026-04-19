// api/vendor/pos/[id]/messages.js
//
// GET  — full message thread for this PO (asc order) + attachments.
//        Side-effect: marks all incoming (sender_type='internal') as read.
// POST — create a new vendor-originated message.
//        body: { body: string, attachments?: Array<{ file_url, file_name,
//                file_size_bytes?, file_mime_type? }> }
//        Attachments are pre-uploaded to bucket 'po-messages' at path
//        '<po_id>/<message_id>/<filename>' by the client; this endpoint
//        validates metadata (PDF/image, <=10MB each, <=5 per message) and
//        creates message + attachment rows.
//        Fires a new_message notification to the internal team.
//
// Real-time: not via WebSocket/SSE (Vercel serverless doesn't support
// long-lived connections). Clients poll unread-count every 60s, or wire
// supabase-js Realtime subscriptions client-side on the po_messages table.

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
  } catch {
    return null;
  }
}

function getPoId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("messages");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const poId = getPoId(req);
  if (!poId) return res.status(400).json({ error: "Missing po id" });

  const { data: po } = await admin
    .from("tanda_pos").select("uuid_id, po_number, vendor_id")
    .eq("uuid_id", poId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!po) return res.status(403).json({ error: "PO not found or not yours" });

  if (req.method === "GET") {
    const { data: messages, error } = await admin
      .from("po_messages")
      .select("*, attachments:po_message_attachments(id, file_url, file_name, file_size_bytes, file_mime_type)")
      .eq("po_id", poId)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const toMark = (messages || [])
      .filter((m) => m.sender_type === "internal" && !m.read_by_vendor)
      .map((m) => m.id);
    if (toMark.length) {
      await admin.from("po_messages").update({ read_by_vendor: true }).in("id", toMark);
    }

    return res.status(200).json(messages);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const messageBody = body?.body;
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
    if (!messageBody || typeof messageBody !== "string" || !messageBody.trim()) {
      return res.status(400).json({ error: "body is required" });
    }
    if (attachments.length > 5) return res.status(400).json({ error: "Max 5 attachments per message" });
    for (const a of attachments) {
      if (!a.file_url || !a.file_name) return res.status(400).json({ error: "Each attachment needs file_url and file_name" });
      if (a.file_size_bytes && Number(a.file_size_bytes) > 10 * 1024 * 1024) return res.status(400).json({ error: `Attachment ${a.file_name} exceeds 10MB` });
      if (a.file_mime_type && !/^(application\/pdf|image\/)/i.test(a.file_mime_type)) return res.status(400).json({ error: "Attachments must be PDF or image" });
    }

    const { data: msg, error: msgErr } = await admin.from("po_messages").insert({
      po_id: poId,
      sender_type: "vendor",
      sender_auth_id: caller.auth_id,
      sender_name: caller.display_name || caller.email || "Vendor",
      body: messageBody.trim(),
      read_by_vendor: true,
      read_by_internal: false,
    }).select("*").single();
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    if (attachments.length) {
      const { error: attErr } = await admin.from("po_message_attachments").insert(
        attachments.map((a) => ({
          message_id: msg.id,
          file_url: a.file_url,
          file_name: a.file_name,
          file_size_bytes: a.file_size_bytes ? Number(a.file_size_bytes) : null,
          file_mime_type: a.file_mime_type || null,
        }))
      );
      if (attErr) return res.status(200).json({ ...msg, attachment_error: attErr.message });
    }

    // Notify each internal messaging team member. Digest behaviour:
    // if 3+ new_message emails have already fired to this address in
    // the past hour, drop email on this one (in-app still posts).
    try {
      const emails = (process.env.INTERNAL_MESSAGE_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
        .split(",").map((e) => e.trim()).filter(Boolean);
      const origin = `https://${req.headers.host}`;
      const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
      await Promise.all(emails.map(async (email) => {
        const { count } = await admin
          .from("notifications")
          .select("*", { count: "exact", head: true })
          .eq("event_type", "new_message")
          .eq("recipient_email", email)
          .eq("email_status", "sent")
          .gte("created_at", oneHourAgo);
        const wantEmail = (count ?? 0) < 3;
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "new_message",
            title: `New message on PO ${po.po_number}`,
            body: messageBody.trim().slice(0, 200),
            link: "/",
            metadata: { po_id: poId, po_number: po.po_number },
            recipient: { internal_id: "po_messages_inbox", email },
            dedupe_key: `new_message_${msg.id}_${email}`,
            email: wantEmail,
          }),
        }).catch(() => {});
      }));
    } catch { /* non-blocking */ }

    return res.status(201).json(msg);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
