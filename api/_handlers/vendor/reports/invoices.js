// api/vendor/reports/invoices.js
//
// GET — paginated invoice history for the caller's vendor.
//   ?status=<submitted|under_review|approved|paid|rejected|disputed>
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  (filter on submitted_at)
//   ?limit=50&offset=0
//
// Response row: { invoice_number, po_number, submitted_at, approved_at,
//                 paid_at, amount, currency, status, match_status,
//                 days_to_payment }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", data.user.id).maybeSingle();
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

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const status = url.searchParams.get("status");
  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  let query = admin
    .from("invoices")
    .select("id, invoice_number, po_id, submitted_at, approved_at, paid_at, total, currency, status", { count: "exact" })
    .eq("vendor_id", caller.vendor_id)
    .order("submitted_at", { ascending: false });
  if (status)   query = query.eq("status", status);
  if (fromDate) query = query.gte("submitted_at", fromDate + "T00:00:00");
  if (toDate)   query = query.lte("submitted_at", toDate + "T23:59:59");
  query = query.range(offset, offset + limit - 1);

  const { data: invRows, error: invErr, count } = await query;
  if (invErr) return res.status(500).json({ error: invErr.message });
  const invoices = invRows || [];

  const poIds = Array.from(new Set(invoices.map((i) => i.po_id).filter(Boolean)));
  const [poRes, matchRes] = await Promise.all([
    poIds.length
      ? admin.from("tanda_pos").select("uuid_id, po_number").in("uuid_id", poIds)
      : Promise.resolve({ data: [], error: null }),
    poIds.length
      ? admin.from("three_way_match_summary").select("po_id, po_status").in("po_id", poIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const poByUuid = new Map(((poRes.data) || []).map((p) => [p.uuid_id, p.po_number]));
  const matchByPo = new Map(((matchRes.data) || []).map((m) => [m.po_id, m.po_status]));

  const rows = invoices.map((i) => {
    let days_to_payment = null;
    if (i.paid_at && i.approved_at) {
      const d = (new Date(i.paid_at).getTime() - new Date(i.approved_at).getTime()) / 86_400_000;
      if (d >= 0) days_to_payment = Math.round(d * 10) / 10;
    }
    return {
      invoice_number: i.invoice_number,
      po_number: i.po_id ? (poByUuid.get(i.po_id) || null) : null,
      submitted_at: i.submitted_at,
      approved_at: i.approved_at,
      paid_at: i.paid_at,
      amount: Number(i.total) || 0,
      currency: i.currency,
      status: i.status,
      match_status: i.po_id ? (matchByPo.get(i.po_id) || null) : null,
      days_to_payment,
    };
  });

  return res.status(200).json({ rows, total: count || 0, limit, offset });
}
