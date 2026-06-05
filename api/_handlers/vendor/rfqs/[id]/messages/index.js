// api/vendor/rfqs/:id/messages
//
// RFQ-linked messaging, vendor side. Lets a vendor message Ring of Fire
// about an RFQ they were invited to, BEFORE any PO exists.
//
// GET  — full thread for this RFQ (asc order).
//        Side-effect: marks incoming (sender_type='internal') as read_by_vendor.
// POST — create a new vendor-originated message. body: { body: string }.
//        Fires an rfq_message notification to the internal procurement team.
//
// Access is gated to vendors who hold an rfq_invitations row for (rfq_id,
// vendor_id) — the same scoping rule the rest of the vendor RFQ surface uses.

import { createClient } from "@supabase/supabase-js";
import { resolveInternalRecipients } from "../../../../../_lib/internal-recipients.js";

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

function getRfqId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rfqs");
  return idx >= 0 ? parts[idx + 1] : null;
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

  const rfqId = getRfqId(req);
  if (!rfqId) return res.status(400).json({ error: "Missing rfq id" });

  // The vendor may only read/post for an RFQ they were invited to.
  const { data: invite } = await admin
    .from("rfq_invitations")
    .select("id")
    .eq("rfq_id", rfqId)
    .eq("vendor_id", caller.vendor_id)
    .maybeSingle();
  if (!invite) return res.status(403).json({ error: "RFQ not found or you were not invited" });

  if (req.method === "GET") {
    // Private 1:1 thread: a vendor only ever sees their OWN messages for this
    // RFQ. Legacy rows with no vendor_id (pre per-vendor scoping) are still
    // shown to the inviting vendor so nothing is silently lost.
    const { data: messages, error } = await admin
      .from("rfq_messages")
      .select("id, rfq_id, vendor_id, sender_type, sender_name, body, read_by_vendor, read_by_internal, created_at")
      .eq("rfq_id", rfqId)
      .or(`vendor_id.eq.${caller.vendor_id},vendor_id.is.null`)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const toMark = (messages || [])
      .filter((m) => m.sender_type === "internal" && !m.read_by_vendor)
      .map((m) => m.id);
    if (toMark.length) {
      await admin.from("rfq_messages").update({ read_by_vendor: true }).in("id", toMark);
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

    const { data: msg, error: msgErr } = await admin.from("rfq_messages").insert({
      rfq_id: rfqId,
      vendor_id: caller.vendor_id,
      sender_type: "vendor",
      sender_auth_id: caller.auth_id,
      sender_name: caller.display_name || caller.email || "Vendor",
      body: messageBody.trim(),
      read_by_vendor: true,
      read_by_internal: false,
    }).select("*").single();
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    // Notify the internal procurement team (env INTERNAL_PROCUREMENT_EMAILS
    // ∪ employees subscribed to "procurement"). Non-blocking.
    try {
      const { emails } = await resolveInternalRecipients(admin, "procurement", { event: "rfq_message" });
      if (emails.length > 0) {
        const [{ data: rfq }, { data: vendor }] = await Promise.all([
          admin.from("rfqs").select("title").eq("id", rfqId).maybeSingle(),
          admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle(),
        ]);
        const vendorName = vendor?.name || caller.display_name || "A vendor";
        const origin = `https://${req.headers.host}`;
        await Promise.all(emails.map((email) =>
          fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "rfq_message",
              title: `${vendorName} sent a message on RFQ ${rfq?.title || ""}`.trim(),
              body: messageBody.trim().slice(0, 200),
              link: "/",
              metadata: { rfq_id: rfqId, vendor_id: caller.vendor_id, message_id: msg.id },
              recipient: { internal_id: "procurement", email },
              dedupe_key: `rfq_message_${msg.id}_${email}`,
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
