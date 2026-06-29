// api/internal/rfqs/messages-inbox
//
// Global RFQ-messages inbox for the internal/buyer side. Threads are PER-VENDOR
// (private 1:1), so this lists one row PER (rfq, invited vendor) conversation —
// driven by rfq_invitations (every SENT RFQ has ≥1 invitation), LEFT-joined to
// rfq_messages aggregates so a conversation appears even with ZERO messages.
// That makes every sent RFQ×vendor selectable in the Costing "Messages" inbox,
// so the buyer can START a new conversation, not just reply to existing ones.
//
// GET → one row per (rfq, invited vendor):
//   {
//     rfq_id,
//     rfq_title,
//     project_name,           // source costing project name (best-effort)
//     vendor_id,
//     vendor_name,
//     total,                  // messages in THIS vendor's thread
//     unread_internal,        // vendor msgs with read_by_internal=false in this thread
//     last_message_at,        // ISO ts of the most recent message (null if none)
//     last_preview,           // body of that most recent message (trimmed)
//   }
// Sorted: unread first, then last_message_at desc (nulls last), then rfq recency.
//
// rfq_messages is RLS-on with NO policies → service-role only; the browser
// cannot query it directly, which is why this lives behind a server handler.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const gate = authenticateInternalCaller(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Every SENT RFQ has ≥1 rfq_invitations row; a draft with no invitations is
  // not messageable and is excluded by construction. One conversation per
  // (rfq, vendor).
  const { data: invites, error: invErr } = await admin
    .from("rfq_invitations")
    .select("rfq_id, vendor_id, vendors(name, legal_name, code)");
  if (invErr) return res.status(500).json({ error: invErr.message });

  const conversations = (invites || []).filter((i) => i.rfq_id && i.vendor_id);
  if (conversations.length === 0) return res.status(200).json([]);

  const rfqIds = [...new Set(conversations.map((i) => i.rfq_id))];

  // RFQ headers: title, status, source costing project (for the "project · RFQ"
  // label) and created_at (the recency tie-breaker). SELECT only columns known
  // to exist on this schema.
  const { data: rfqs } = await admin
    .from("rfqs")
    .select("id, title, status, source_costing_project_id, created_at")
    .in("id", rfqIds);
  const rfqById = new Map((rfqs || []).map((r) => [r.id, r]));

  const projectIds = [...new Set((rfqs || []).map((r) => r.source_costing_project_id).filter(Boolean))];
  const projectNameById = new Map();
  if (projectIds.length > 0) {
    const { data: projects } = await admin
      .from("costing_projects")
      .select("id, project_name")
      .in("id", projectIds);
    for (const p of projects || []) projectNameById.set(p.id, p.project_name || null);
  }

  // Message aggregates per (rfq_id, vendor_id). Pull every message newest-first
  // and fold; the first one seen for a key is its most-recent message. Legacy
  // rows with no vendor_id can't be attributed to a private thread, so they are
  // skipped here (they still surface inside the per-vendor thread via the
  // vendor_id IS NULL fold in the messages handler).
  const { data: messages, error: msgErr } = await admin
    .from("rfq_messages")
    .select("rfq_id, vendor_id, sender_type, body, read_by_internal, created_at")
    .order("created_at", { ascending: false });
  if (msgErr) return res.status(500).json({ error: msgErr.message });

  const aggByKey = new Map();
  const keyOf = (rfqId, vendorId) => `${rfqId}::${vendorId}`;
  for (const m of messages || []) {
    if (!m.rfq_id || !m.vendor_id) continue;
    const key = keyOf(m.rfq_id, m.vendor_id);
    let agg = aggByKey.get(key);
    if (!agg) {
      agg = { last_message_at: m.created_at, last_preview: (m.body || "").trim().slice(0, 160), total: 0, unread_internal: 0 };
      aggByKey.set(key, agg);
    }
    agg.total += 1;
    if (m.sender_type === "vendor" && !m.read_by_internal) agg.unread_internal += 1;
  }

  const rows = conversations.map((conv) => {
    const rfq = rfqById.get(conv.rfq_id) || {};
    const v = conv.vendors || {};
    const agg = aggByKey.get(keyOf(conv.rfq_id, conv.vendor_id));
    return {
      rfq_id: conv.rfq_id,
      rfq_title: rfq.title || null,
      status: rfq.status ?? null,
      project_name: rfq.source_costing_project_id ? (projectNameById.get(rfq.source_costing_project_id) || null) : null,
      vendor_id: conv.vendor_id,
      vendor_name: v.name || v.legal_name || v.code || null,
      total: agg?.total ?? 0,
      unread_internal: agg?.unread_internal ?? 0,
      last_message_at: agg?.last_message_at ?? null,
      last_preview: agg?.last_preview ?? "",
      _rfq_created_at: rfq.created_at || null,
    };
  });

  // Unread first; then most-recent-message first (nulls last); then RFQ recency.
  rows.sort((a, b) => {
    if (b.unread_internal !== a.unread_internal) return b.unread_internal - a.unread_internal;
    if (!!b.last_message_at !== !!a.last_message_at) return a.last_message_at ? -1 : 1;
    if (a.last_message_at && b.last_message_at && a.last_message_at !== b.last_message_at) {
      return String(b.last_message_at).localeCompare(String(a.last_message_at));
    }
    return String(b._rfq_created_at || "").localeCompare(String(a._rfq_created_at || ""));
  });

  for (const r of rows) delete r._rfq_created_at;
  return res.status(200).json(rows);
}
