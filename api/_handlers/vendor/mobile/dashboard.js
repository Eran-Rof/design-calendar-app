// api/vendor/mobile/dashboard
//
// GET — leaner dashboard tailored for the mobile home screen.
// Returns: recent_pos (5), unread_notifications count, unread_messages
// count, pending_rfqs count (invited + viewed), compliance_alerts
// count (expired or expiring ≤30 days).

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

  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);

  const [posRes, notifRes, msgCountRes, rfqRes, docTypesRes, docsRes] = await Promise.all([
    admin.from("tanda_pos").select("uuid_id, po_number, data").eq("vendor_id", caller.vendor_id).order("date_order", { ascending: false }).limit(5),
    admin.from("notifications").select("id", { count: "exact", head: true }).eq("recipient_auth_id", caller.auth_id).is("read_at", null),
    admin.from("po_messages").select("id", { count: "exact", head: true }).eq("sender_type", "internal").eq("read_by_vendor", false).in("po_id", (await admin.from("tanda_pos").select("uuid_id").eq("vendor_id", caller.vendor_id)).data?.map((r) => r.uuid_id) || []),
    admin.from("rfq_invitations").select("id", { count: "exact", head: true }).eq("vendor_id", caller.vendor_id).in("status", ["invited", "viewed"]),
    admin.from("compliance_document_types").select("id, required").eq("active", true).eq("required", true),
    admin.from("compliance_documents").select("document_type_id, status, expiry_date, uploaded_at").eq("vendor_id", caller.vendor_id),
  ]);

  // compliance_alerts: required types that are expired or expiring ≤30d, or never uploaded, or rejected
  const requiredIds = (docTypesRes.data || []).map((t) => t.id);
  const latest = new Map();
  for (const d of docsRes.data || []) {
    const prev = latest.get(d.document_type_id);
    if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latest.set(d.document_type_id, d);
  }
  let alerts = 0;
  for (const tid of requiredIds) {
    const d = latest.get(tid);
    if (!d || d.status === "rejected") { alerts++; continue; }
    if (d.status !== "approved") { alerts++; continue; }
    if (d.expiry_date) {
      const ms = new Date(d.expiry_date).getTime();
      if (ms < now.getTime() || ms < in30.getTime()) alerts++;
    }
  }

  const recent_pos = (posRes.data || []).map((p) => ({
    id: p.uuid_id,
    po_number: p.po_number,
    status: p.data?.StatusName || "—",
    amount: Number(p.data?.TotalAmount) || 0,
  }));

  return res.status(200).json({
    recent_pos,
    unread_notifications: notifRes.count || 0,
    unread_messages: msgCountRes.count || 0,
    pending_rfqs: rfqRes.count || 0,
    compliance_alerts: alerts,
  });
}
