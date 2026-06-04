// api/internal/vendor-invites
//
// GET — vendor-portal invitations, one row per (vendor, email) = the latest
// token, with a derived status:
//   pending  — latest token unused and not yet expired
//   expired  — latest token unused and past its 72h window
//   accepted — the vendor used an invite token (set their password)
//
// Optional ?status=outstanding returns only pending + expired (the ones that
// need a resend). Backs the "Outstanding invitations" panel + Resend button.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const statusFilter = (url.searchParams.get("status") || "").trim();

  const { data: rows, error } = await admin
    .from("vendor_invite_tokens")
    .select("id, vendor_id, email, display_name, expires_at, used_at, created_at, vendor:vendors(id, name)")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Collapse to one entry per (vendor_id, lower(email)). Rows are newest-first,
  // so the first seen per key is the latest token; aggregate ever_accepted.
  const byKey = new Map();
  for (const r of rows || []) {
    const key = `${r.vendor_id}|${(r.email || "").toLowerCase()}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        id: r.id, vendor_id: r.vendor_id, vendor_name: r.vendor?.name || null,
        email: r.email, display_name: r.display_name,
        sent_at: r.created_at, expires_at: r.expires_at, ever_accepted: false,
      };
      byKey.set(key, g);
    }
    if (r.used_at) g.ever_accepted = true;
  }

  const now = Date.now();
  let out = [...byKey.values()].map((g) => ({
    id: g.id,
    vendor_id: g.vendor_id,
    vendor_name: g.vendor_name,
    email: g.email,
    display_name: g.display_name,
    sent_at: g.sent_at,
    expires_at: g.expires_at,
    status: g.ever_accepted ? "accepted" : (new Date(g.expires_at).getTime() > now ? "pending" : "expired"),
  }));

  if (statusFilter === "outstanding") out = out.filter((x) => x.status !== "accepted");
  else if (statusFilter) out = out.filter((x) => x.status === statusFilter);

  // Outstanding first (expired, then pending), accepted last; newest-first within.
  const rank = { expired: 0, pending: 1, accepted: 2 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || (new Date(b.sent_at) - new Date(a.sent_at)));

  return res.status(200).json(out);
}
