// api/vendor/rfqs/messages-inbox
//
// GET → the authenticated vendor's RFQ message threads: every RFQ they're
// invited to, with their per-(rfq,vendor) message totals + unread count (incoming
// internal messages not yet read by the vendor) + last-message time. rfq_messages
// is service-role only, so the vendor browser can't read it directly — this is the
// vendor-scoped equivalent of the internal rfqs/messages-inbox. Backs the
// Messages → RFQs tab in the vendor portal.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin
      .from("vendor_users").select("vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { vendor_id: vu.vendor_id } : null;
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

  const caller = await resolveVendor(admin, req.headers.authorization || "");
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  // RFQs this vendor is invited to.
  const { data: invs, error: iErr } = await admin
    .from("rfq_invitations").select("rfq_id").eq("vendor_id", caller.vendor_id);
  if (iErr) return res.status(500).json({ error: iErr.message });
  const rfqIds = [...new Set((invs || []).map((i) => i.rfq_id).filter(Boolean))];
  if (rfqIds.length === 0) return res.status(200).json([]);

  const { data: rfqs } = await admin.from("rfqs").select("id, title, status").in("id", rfqIds);
  const metaById = Object.fromEntries((rfqs || []).map((r) => [r.id, r]));

  // This vendor's thread on each RFQ (vendor_id match, or legacy unscoped null).
  const { data: msgs } = await admin
    .from("rfq_messages")
    .select("rfq_id, sender_type, read_by_vendor, created_at, vendor_id")
    .in("rfq_id", rfqIds)
    .order("created_at", { ascending: false });
  const mine = (msgs || []).filter((m) => m.vendor_id === caller.vendor_id || m.vendor_id == null);

  const agg = new Map();
  for (const m of mine) {
    let g = agg.get(m.rfq_id);
    if (!g) { g = { total: 0, unread: 0, last: m.created_at }; agg.set(m.rfq_id, g); } // msgs desc → first seen = newest
    g.total += 1;
    if (m.sender_type === "internal" && !m.read_by_vendor) g.unread += 1;
  }

  const out = rfqIds.map((id) => {
    const meta = metaById[id];
    const g = agg.get(id);
    return {
      rfq_id: id,
      title: meta?.title || "RFQ",
      status: meta?.status || null,
      total: g ? g.total : 0,
      unread: g ? g.unread : 0,
      last_message_at: g ? g.last : null,
    };
  });
  out.sort((a, b) =>
    (b.unread - a.unread) ||
    (new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)) ||
    a.title.localeCompare(b.title));

  return res.status(200).json(out);
}
