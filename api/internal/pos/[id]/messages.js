// api/internal/pos/[id]/messages.js
//
// GET  — full thread for this PO (asc) + attachments.
//        Side-effect: marks all incoming (sender_type='vendor') as read.
// POST — create a new internal-originated message.
//        body: { body, sender_internal_id, sender_name,
//                attachments?: [{ file_url, file_name, file_size_bytes?, file_mime_type? }] }
//        Validates attachments (PDF/image, <=10MB, <=5 per message).
//        Fires new_message notification to the vendor's primary user.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

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

  const poId = getPoId(req);
  if (!poId) return res.status(400).json({ error: "Missing po id" });

  const { data: po } = await admin
    .from("tanda_pos").select("uuid_id, po_number, vendor_id")
    .eq("uuid_id", poId).maybeSingle();
  if (!po) return res.status(404).json({ error: "PO not found" });

  if (req.method === "GET") {
    const { data: messages, error } = await admin
      .from("po_messages")
      .select("*, attachments:po_message_attachments(id, file_url, file_name, file_size_bytes, file_mime_type)")
      .eq("po_id", poId)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const toMark = (messages || [])
      .filter((m) => m.sender_type === "vendor" && !m.read_by_internal)
      .map((m) => m.id);
    if (toMark.length) {
      await admin.from("po_messages").update({ read_by_internal: true }).in("id", toMark);
    }

    return res.status(200).json(messages);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const messageBody = body?.body;
    const senderInternalId = body?.sender_internal_id;
    const senderName = body?.sender_name;
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
    if (!messageBody || typeof messageBody !== "string" || !messageBody.trim()) return res.status(400).json({ error: "body is required" });
    if (!senderInternalId || !senderName) return res.status(400).json({ error: "sender_internal_id and sender_name required" });
    if (attachments.length > 5) return res.status(400).json({ error: "Max 5 attachments per message" });
    for (const a of attachments) {
      if (!a.file_url || !a.file_name) return res.status(400).json({ error: "Each attachment needs file_url and file_name" });
      if (a.file_size_bytes && Number(a.file_size_bytes) > 10 * 1024 * 1024) return res.status(400).json({ error: `Attachment ${a.file_name} exceeds 10MB` });
      if (a.file_mime_type && !/^(application\/pdf|image\/)/i.test(a.file_mime_type)) return res.status(400).json({ error: "Attachments must be PDF or image" });
    }

    const { data: msg, error: msgErr } = await admin.from("po_messages").insert({
      po_id: poId,
      sender_type: "internal",
      sender_internal_id: senderInternalId,
      sender_name: senderName,
      body: messageBody.trim(),
      read_by_vendor: false,
      read_by_internal: true,
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

    // Notify the vendor primary user. Digest: if 3+ new_message emails
    // have already fired to this vendor's primary user in the past
    // hour, drop email on this one.
    if (po.vendor_id) {
      try {
        const origin = `https://${req.headers.host}`;

        // Find primary vendor_user's auth_id to count their prior emails
        const { data: primary } = await admin
          .from("vendor_users").select("auth_id")
          .eq("vendor_id", po.vendor_id).eq("role", "primary").maybeSingle();
        let wantEmail = true;
        if (primary?.auth_id) {
          const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
          const { count } = await admin
            .from("notifications")
            .select("*", { count: "exact", head: true })
            .eq("event_type", "new_message")
            .eq("recipient_auth_id", primary.auth_id)
            .eq("email_status", "sent")
            .gte("created_at", oneHourAgo);
          if ((count ?? 0) >= 3) wantEmail = false;
        }

        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "new_message",
            title: `New message on PO ${po.po_number}`,
            body: messageBody.trim().slice(0, 200),
            link: "/vendor/messages",
            metadata: { po_id: poId, po_number: po.po_number },
            recipient: { vendor_id: po.vendor_id },
            dedupe_key: `new_message_${msg.id}_vendor`,
            email: wantEmail,
          }),
        }).catch(() => {});
      } catch { /* non-blocking */ }
    }

    return res.status(201).json(msg);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
