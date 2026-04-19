// api/vendor/disputes
//
// GET — list all disputes for the caller's vendor with last-message
// timestamp and unread count (internal messages newer than
// disputes.last_viewed_by_vendor_at).
//
// POST — create a new dispute.
//   body: { type, subject, body, invoice_id?, po_id?, priority? }
// Creates the dispute (status='open', raised_by=vendor) + the opening
// dispute_messages row. Fires dispute_opened notification to
// INTERNAL_DISPUTE_EMAILS (falls back to INTERNAL_COMPLIANCE_EMAILS).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

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

  if (req.method === "GET") {
    const { data: disputes, error } = await admin
      .from("disputes")
      .select("*")
      .eq("vendor_id", caller.vendor_id)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const ids = (disputes || []).map((d) => d.id);
    // Pull messages once and aggregate in-memory
    let lastByDispute = new Map();
    let unreadByDispute = new Map();
    if (ids.length) {
      const { data: msgs } = await admin
        .from("dispute_messages")
        .select("dispute_id, sender_type, created_at")
        .in("dispute_id", ids);
      const disputeById = new Map((disputes || []).map((d) => [d.id, d]));
      for (const m of msgs || []) {
        const prev = lastByDispute.get(m.dispute_id);
        if (!prev || new Date(m.created_at) > new Date(prev)) lastByDispute.set(m.dispute_id, m.created_at);
        if (m.sender_type === "internal") {
          const d = disputeById.get(m.dispute_id);
          const viewed = d?.last_viewed_by_vendor_at ? new Date(d.last_viewed_by_vendor_at) : new Date(0);
          if (new Date(m.created_at) > viewed) unreadByDispute.set(m.dispute_id, (unreadByDispute.get(m.dispute_id) || 0) + 1);
        }
      }
    }

    return res.status(200).json((disputes || []).map((d) => ({
      ...d,
      last_message_at: lastByDispute.get(d.id) || d.created_at,
      unread_count: unreadByDispute.get(d.id) || 0,
    })));
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { type, subject, body: messageBody, invoice_id, po_id, priority } = body || {};
    if (!type || !["invoice_discrepancy", "payment_delay", "damaged_goods", "other"].includes(type))
      return res.status(400).json({ error: "type must be invoice_discrepancy, payment_delay, damaged_goods, or other" });
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: "subject is required" });
    if (!messageBody || !String(messageBody).trim()) return res.status(400).json({ error: "body is required" });
    if (priority && !["low", "medium", "high"].includes(priority)) return res.status(400).json({ error: "priority must be low, medium, or high" });

    // Verify invoice/po belong to caller
    if (invoice_id) {
      const { data: inv } = await admin.from("invoices").select("id").eq("id", invoice_id).eq("vendor_id", caller.vendor_id).maybeSingle();
      if (!inv) return res.status(403).json({ error: "invoice_id not found or not yours" });
    }
    if (po_id) {
      const { data: po } = await admin.from("tanda_pos").select("uuid_id").eq("uuid_id", po_id).eq("vendor_id", caller.vendor_id).maybeSingle();
      if (!po) return res.status(403).json({ error: "po_id not found or not yours" });
    }

    const { data: dispute, error: dErr } = await admin.from("disputes").insert({
      vendor_id: caller.vendor_id,
      invoice_id: invoice_id || null,
      po_id: po_id || null,
      type,
      status: "open",
      priority: priority || "medium",
      subject: String(subject).trim(),
      raised_by_type: "vendor",
      raised_by_vendor_user_id: caller.id,
      last_viewed_by_vendor_at: new Date().toISOString(),
    }).select("*").single();
    if (dErr) return res.status(500).json({ error: dErr.message });

    const { error: mErr } = await admin.from("dispute_messages").insert({
      dispute_id: dispute.id,
      sender_type: "vendor",
      sender_auth_id: caller.auth_id,
      sender_name: caller.display_name || caller.email || "Vendor",
      body: String(messageBody).trim(),
    });
    if (mErr) return res.status(200).json({ ...dispute, message_error: mErr.message });

    // Internal notifications
    try {
      const emails = (process.env.INTERNAL_DISPUTE_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
        .split(",").map((e) => e.trim()).filter(Boolean);
      if (emails.length > 0) {
        const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
        const vendorName = vendor?.name || "A vendor";
        const origin = `https://${req.headers.host}`;
        await Promise.all(emails.map((email) =>
          fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "dispute_opened",
              title: `New dispute from ${vendorName}: ${dispute.subject}`,
              body: `${type.replace(/_/g, " ")} · priority ${dispute.priority}\n\n${String(messageBody).trim().slice(0, 300)}`,
              link: "/",
              metadata: { dispute_id: dispute.id, vendor_id: caller.vendor_id, type, priority: dispute.priority },
              recipient: { internal_id: "disputes_team", email },
              dedupe_key: `dispute_opened_${dispute.id}_${email}`,
              email: true,
            }),
          }).catch(() => {})
        ));
      }
    } catch { /* non-blocking */ }

    return res.status(201).json(dispute);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
