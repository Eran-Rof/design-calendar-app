// api/internal/disputes
//
// GET — all disputes across vendors with filters.
//   ?status= ?type= ?priority= ?vendor_id=
// Ordered by priority desc (high first), then created_at asc (oldest
// high-priority first).
// Each row includes vendor name and last_message_at + unread_count_internal.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 30 };

const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");
  const priority = url.searchParams.get("priority");
  const vendorId = url.searchParams.get("vendor_id");

  let query = admin.from("disputes").select("*, vendor:vendors(id, name)");
  if (status)   query = query.eq("status", status);
  if (type)     query = query.eq("type", type);
  if (priority) query = query.eq("priority", priority);
  if (vendorId) query = query.eq("vendor_id", vendorId);

  const { data: disputes, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Attach last-message + unread count (vendor messages newer than last_viewed_by_internal_at)
  const ids = (disputes || []).map((d) => d.id);
  const lastByDispute = new Map();
  const unreadByDispute = new Map();
  if (ids.length) {
    const { data: msgs } = await admin
      .from("dispute_messages")
      .select("dispute_id, sender_type, created_at")
      .in("dispute_id", ids);
    const byId = new Map((disputes || []).map((d) => [d.id, d]));
    for (const m of msgs || []) {
      const prev = lastByDispute.get(m.dispute_id);
      if (!prev || new Date(m.created_at) > new Date(prev)) lastByDispute.set(m.dispute_id, m.created_at);
      if (m.sender_type === "vendor") {
        const d = byId.get(m.dispute_id);
        const viewed = d?.last_viewed_by_internal_at ? new Date(d.last_viewed_by_internal_at) : new Date(0);
        if (new Date(m.created_at) > viewed) unreadByDispute.set(m.dispute_id, (unreadByDispute.get(m.dispute_id) || 0) + 1);
      }
    }
  }

  const rows = (disputes || []).map((d) => ({
    ...d,
    last_message_at: lastByDispute.get(d.id) || d.created_at,
    unread_count_internal: unreadByDispute.get(d.id) || 0,
  }));

  rows.sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] || 0;
    const pb = PRIORITY_RANK[b.priority] || 0;
    if (pa !== pb) return pb - pa; // high first
    // Oldest first within the same priority (SLA front-of-queue)
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return res.status(200).json(rows);
}
