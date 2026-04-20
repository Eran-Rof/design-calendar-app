// api/internal/messages/inbox.js
//
// GET — list of POs with unread vendor messages, ordered by most recent
// activity first. Used by the internal TandA Messages view.
//
// Response shape:
//   [{ po_id, po_number, vendor_id, vendor_name,
//      unread_count, last_message_at, last_message_preview,
//      last_message_sender_name }]

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

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

  // Fetch unread vendor messages grouped in-memory. At scale, move this to
  // a SQL view or function; for now the row count is small enough.
  const { data: unread, error } = await admin
    .from("po_messages")
    .select("id, po_id, body, sender_name, created_at")
    .eq("sender_type", "vendor")
    .eq("read_by_internal", false)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  if (!unread || unread.length === 0) return res.status(200).json([]);

  // Latest message + unread count per po_id
  const byPo = new Map();
  for (const m of unread) {
    const existing = byPo.get(m.po_id);
    if (!existing) {
      byPo.set(m.po_id, {
        po_id: m.po_id,
        unread_count: 1,
        last_message_at: m.created_at,
        last_message_preview: (m.body || "").slice(0, 200),
        last_message_sender_name: m.sender_name,
      });
    } else {
      existing.unread_count++;
      // `unread` is ordered DESC by created_at; the first seen per po is the latest
    }
  }

  const poIds = Array.from(byPo.keys());
  const { data: pos } = await admin.from("tanda_pos")
    .select("uuid_id, po_number, vendor_id")
    .in("uuid_id", poIds);
  const vendorIds = Array.from(new Set((pos || []).map((p) => p.vendor_id).filter(Boolean)));
  const { data: vendors } = vendorIds.length
    ? await admin.from("vendors").select("id, name").in("id", vendorIds)
    : { data: [] };
  const vendorById = new Map((vendors || []).map((v) => [v.id, v.name]));

  const rows = [];
  for (const p of pos || []) {
    const u = byPo.get(p.uuid_id);
    if (!u) continue;
    rows.push({
      po_id: p.uuid_id,
      po_number: p.po_number,
      vendor_id: p.vendor_id,
      vendor_name: vendorById.get(p.vendor_id) || null,
      unread_count: u.unread_count,
      last_message_at: u.last_message_at,
      last_message_preview: u.last_message_preview,
      last_message_sender_name: u.last_message_sender_name,
    });
  }

  rows.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
  return res.status(200).json(rows);
}
