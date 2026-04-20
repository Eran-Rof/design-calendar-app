// api/vendor/rfqs
//
// GET — RFQs this vendor has been invited to, with invitation state
// and the vendor's quote (if any) inlined.
// Filters: ?status=draft|published|closed|awarded
// Rows include:
//   { rfq: {...}, invitation: {status, invited_at, viewed_at}, quote: {...} | null }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
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

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const status = url.searchParams.get("status");

  const { data: invitations, error: invErr } = await admin
    .from("rfq_invitations")
    .select("*, rfq:rfqs(id, title, description, category, status, submission_deadline, delivery_required_by, estimated_quantity, estimated_budget, currency, awarded_to_vendor_id)")
    .eq("vendor_id", caller.vendor_id)
    .order("invited_at", { ascending: false });
  if (invErr) return res.status(500).json({ error: invErr.message });

  const rfqIds = (invitations || []).map((i) => i.rfq?.id).filter(Boolean);
  let myQuotes = [];
  if (rfqIds.length > 0) {
    const { data: qts } = await admin
      .from("rfq_quotes")
      .select("*")
      .eq("vendor_id", caller.vendor_id)
      .in("rfq_id", rfqIds);
    myQuotes = qts || [];
  }
  const quoteByRfq = new Map(myQuotes.map((q) => [q.rfq_id, q]));

  let rows = (invitations || [])
    .filter((i) => i.rfq)
    .map((i) => ({
      invitation: {
        id: i.id, status: i.status, invited_at: i.invited_at,
        viewed_at: i.viewed_at, declined_at: i.declined_at,
      },
      rfq: i.rfq,
      quote: quoteByRfq.get(i.rfq.id) || null,
    }));
  if (status) rows = rows.filter((r) => r.rfq.status === status);

  return res.status(200).json(rows);
}
