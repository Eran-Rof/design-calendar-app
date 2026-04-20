// api/vendor/mobile/feed
//
// GET — activity feed for the mobile home screen. Unions events from
// notifications (in-app), po_messages (internal → vendor), rfq
// invitations, and compliance document reviews. Returns last 20 items
// sorted by timestamp desc. Each item:
//   { type, title, subtitle, timestamp, deep_link }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendorUser(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendorUser(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const poIdsRes = await admin.from("tanda_pos").select("uuid_id, po_number").eq("vendor_id", caller.vendor_id);
  const poById = new Map((poIdsRes.data || []).map((p) => [p.uuid_id, p.po_number]));
  const poIds = [...poById.keys()];

  const [notifs, messages, rfqInvs, discDocs] = await Promise.all([
    admin.from("notifications")
      .select("id, event_type, title, body, link, created_at, metadata")
      .eq("recipient_auth_id", caller.auth_id)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20),
    poIds.length > 0
      ? admin.from("po_messages")
          .select("id, po_id, body, sender_name, created_at")
          .eq("sender_type", "internal")
          .in("po_id", poIds)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),
    admin.from("rfq_invitations")
      .select("id, rfq_id, status, invited_at, rfq:rfqs(title)")
      .eq("vendor_id", caller.vendor_id)
      .gte("invited_at", since)
      .order("invited_at", { ascending: false })
      .limit(20),
    admin.from("compliance_documents")
      .select("id, status, uploaded_at, reviewed_at, document_type:compliance_document_types(name)")
      .eq("vendor_id", caller.vendor_id)
      .not("reviewed_at", "is", null)
      .gte("reviewed_at", since)
      .order("reviewed_at", { ascending: false })
      .limit(20),
  ]);

  const feed = [];

  for (const n of notifs.data || []) {
    feed.push({
      type: n.event_type || "notification",
      title: n.title,
      subtitle: n.body || "",
      timestamp: n.created_at,
      deep_link: linkToDeep(n.event_type, n.metadata, n.link),
    });
  }
  for (const m of messages.data || []) {
    feed.push({
      type: "new_message",
      title: `Message on PO ${poById.get(m.po_id) || ""}`,
      subtitle: `${m.sender_name}: ${(m.body || "").slice(0, 80)}`,
      timestamp: m.created_at,
      deep_link: `vendor://pos/${m.po_id}/messages`,
    });
  }
  for (const r of rfqInvs.data || []) {
    feed.push({
      type: "rfq_invited",
      title: `RFQ invitation: ${r.rfq?.title || ""}`,
      subtitle: `Status: ${r.status}`,
      timestamp: r.invited_at,
      deep_link: `vendor://rfqs/${r.rfq_id}`,
    });
  }
  for (const d of discDocs.data || []) {
    feed.push({
      type: d.status === "approved" ? "compliance_approved" : "compliance_rejected",
      title: `Compliance ${d.status}: ${d.document_type?.name || "document"}`,
      subtitle: d.status === "rejected" ? "Needs a new upload" : "Document is current",
      timestamp: d.reviewed_at,
      deep_link: "vendor://compliance",
    });
  }

  feed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return res.status(200).json(feed.slice(0, 20));
}

function linkToDeep(eventType, metadata, link) {
  if (metadata?.po_number)   return `vendor://pos/${metadata.po_id || metadata.po_number}`;
  if (metadata?.rfq_id)      return `vendor://rfqs/${metadata.rfq_id}`;
  if (metadata?.invoice_id)  return `vendor://invoices/${metadata.invoice_id}`;
  if (metadata?.dispute_id)  return `vendor://disputes/${metadata.dispute_id}`;
  if (metadata?.contract_id) return `vendor://contracts/${metadata.contract_id}`;
  return link || "vendor://home";
}
