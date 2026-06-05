// api/internal/rfqs/messages-inbox
//
// Global RFQ-messages inbox for the internal/buyer side. The per-RFQ thread
// lives at /api/internal/rfqs/:id/messages; this endpoint aggregates ACROSS
// rfqs so the Costing module can show a single "Messages" list of every RFQ
// that has at least one message.
//
// GET → one row per RFQ that has ≥1 rfq_messages row:
//   {
//     rfq_id,
//     rfq_title,
//     last_message_at,        // ISO ts of the most recent message
//     last_message_preview,   // body of that most recent message (trimmed)
//     unread_internal,        // count of vendor messages with read_by_internal=false
//     total,                  // total messages in the thread
//     vendor_names,           // string[] of invited vendor names (best-effort)
//   }
// Sorted unread-first (unread_internal desc), then last_message_at desc.
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

  // Pull every message (newest first) and fold into a per-RFQ summary. The
  // rfq_messages table is the only place these live, so we aggregate here in
  // JS rather than relying on a DB view (none exists for this shape today).
  const { data: messages, error } = await admin
    .from("rfq_messages")
    .select("rfq_id, sender_type, sender_name, body, read_by_internal, created_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const byRfq = new Map();
  for (const m of messages || []) {
    if (!m.rfq_id) continue;
    let agg = byRfq.get(m.rfq_id);
    if (!agg) {
      // First message seen for this RFQ is the most recent one (desc order).
      agg = {
        rfq_id: m.rfq_id,
        rfq_title: null,
        last_message_at: m.created_at,
        last_message_preview: (m.body || "").trim().slice(0, 160),
        unread_internal: 0,
        total: 0,
        vendor_names: [],
        _vendorSenderNames: new Set(),
      };
      byRfq.set(m.rfq_id, agg);
    }
    agg.total += 1;
    if (m.sender_type === "vendor") {
      if (!m.read_by_internal) agg.unread_internal += 1;
      if (m.sender_name && m.sender_name.trim()) agg._vendorSenderNames.add(m.sender_name.trim());
    }
  }

  const rfqIds = [...byRfq.keys()];
  if (rfqIds.length === 0) return res.status(200).json([]);

  // RFQ titles. SELECT only columns that exist today (title, status) — NOT
  // rfqs.code, which may not exist on this schema yet.
  const { data: rfqs } = await admin
    .from("rfqs")
    .select("id, title, status")
    .in("id", rfqIds);
  for (const r of rfqs || []) {
    const agg = byRfq.get(r.id);
    if (agg) {
      agg.rfq_title = r.title || null;
      agg.status = r.status || null;
    }
  }

  // Invited vendor name(s) per RFQ (best-effort — empty for ad-hoc threads
  // with no invitations). Falls back to the distinct vendor sender names seen
  // in the thread when no invitation rows exist.
  const { data: invites } = await admin
    .from("rfq_invitations")
    .select("rfq_id, vendor_id, vendors(name, legal_name, code)")
    .in("rfq_id", rfqIds);
  const invNamesByRfq = new Map();
  for (const inv of invites || []) {
    const v = inv.vendors || {};
    const name = v.name || v.legal_name || v.code || null;
    if (!name) continue;
    let set = invNamesByRfq.get(inv.rfq_id);
    if (!set) { set = new Set(); invNamesByRfq.set(inv.rfq_id, set); }
    set.add(name);
  }

  const rows = [...byRfq.values()].map((agg) => {
    const invSet = invNamesByRfq.get(agg.rfq_id);
    const names = invSet && invSet.size > 0
      ? [...invSet]
      : [...agg._vendorSenderNames];
    return {
      rfq_id: agg.rfq_id,
      rfq_title: agg.rfq_title,
      status: agg.status ?? null,
      last_message_at: agg.last_message_at,
      last_message_preview: agg.last_message_preview,
      unread_internal: agg.unread_internal,
      total: agg.total,
      vendor_names: names,
    };
  });

  // Unread-first, then most-recent-message first.
  rows.sort((a, b) => {
    if (b.unread_internal !== a.unread_internal) return b.unread_internal - a.unread_internal;
    return String(b.last_message_at).localeCompare(String(a.last_message_at));
  });

  return res.status(200).json(rows);
}
