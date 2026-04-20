// api/vendor/disputes/:id/messages
//
// POST — add a vendor message to an existing dispute thread.
//   body: { body: string }
// Fires new_dispute_message notification to internal team.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id, display_name").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id, email: data.user.email } : null;
  } catch { return null; }
}

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const msgIdx = parts.lastIndexOf("messages");
  return msgIdx > 0 ? parts[msgIdx - 1] : null;
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

  const disputeId = getId(req);
  if (!disputeId) return res.status(400).json({ error: "Missing dispute id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const messageBody = body?.body;
  if (!messageBody || !String(messageBody).trim()) return res.status(400).json({ error: "body is required" });

  const { data: dispute } = await admin
    .from("disputes").select("id, vendor_id, subject, status").eq("id", disputeId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });

  const { data: msg, error: mErr } = await admin.from("dispute_messages").insert({
    dispute_id: disputeId,
    sender_type: "vendor",
    sender_auth_id: caller.auth_id,
    sender_name: caller.display_name || caller.email || "Vendor",
    body: String(messageBody).trim(),
  }).select("*").single();
  if (mErr) return res.status(500).json({ error: mErr.message });

  // Update viewed-at and dispute.updated_at
  await admin.from("disputes").update({
    last_viewed_by_vendor_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", disputeId);

  // Notify internal team
  try {
    const emails = (process.env.INTERNAL_DISPUTE_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
      .split(",").map((e) => e.trim()).filter(Boolean);
    if (emails.length > 0) {
      const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
      const vendorName = vendor?.name || "Vendor";
      const origin = `https://${req.headers.host}`;

      // Digest: if 3+ new_dispute_message emails already sent to this
      // address in the last hour, drop email on this one.
      const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
      await Promise.all(emails.map(async (email) => {
        const { count } = await admin
          .from("notifications")
          .select("*", { count: "exact", head: true })
          .eq("event_type", "new_dispute_message")
          .eq("recipient_email", email)
          .eq("email_status", "sent")
          .gte("created_at", oneHourAgo);
        const wantEmail = (count ?? 0) < 3;

        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "new_dispute_message",
            title: `New message on dispute: ${dispute.subject}`,
            body: `${vendorName}: ${String(messageBody).trim().slice(0, 240)}`,
            link: "/",
            metadata: { dispute_id: disputeId, vendor_id: caller.vendor_id },
            recipient: { internal_id: "disputes_team", email },
            dedupe_key: `dispute_msg_${msg.id}_${email}`,
            email: wantEmail,
          }),
        }).catch(() => {});
      }));
    }
  } catch { /* non-blocking */ }

  return res.status(201).json(msg);
}
