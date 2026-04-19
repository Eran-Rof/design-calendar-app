// api/vendor/rfqs/:id
//
// GET — RFQ detail for an invited vendor. Returns RFQ header, line
// items, the vendor's invitation row, and the vendor's own draft/
// submitted quote (never any other vendor's quote).
//
// Side effect: on the first view, the invitation's viewed_at is set
// and status flips 'invited' → 'viewed'.

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

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rfqs");
  return idx >= 0 ? parts[idx + 1] : null;
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

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing rfq id" });

  // Enforce: vendor must have an invitation to see this RFQ
  const { data: invitation } = await admin
    .from("rfq_invitations")
    .select("*")
    .eq("rfq_id", id)
    .eq("vendor_id", caller.vendor_id)
    .maybeSingle();
  if (!invitation) return res.status(404).json({ error: "RFQ not found or you're not invited" });

  const [rfqRes, liRes, qtRes] = await Promise.all([
    admin.from("rfqs").select("*").eq("id", id).maybeSingle(),
    admin.from("rfq_line_items").select("*").eq("rfq_id", id).order("line_index", { ascending: true }),
    admin.from("rfq_quotes").select("*, lines:rfq_quote_lines(*)").eq("rfq_id", id).eq("vendor_id", caller.vendor_id).maybeSingle(),
  ]);

  // Mark viewed on first visit
  if (!invitation.viewed_at) {
    await admin.from("rfq_invitations").update({
      viewed_at: new Date().toISOString(),
      status: invitation.status === "invited" ? "viewed" : invitation.status,
    }).eq("id", invitation.id);
  }

  return res.status(200).json({
    rfq: rfqRes.data,
    line_items: liRes.data || [],
    invitation,
    quote: qtRes.data || null,
  });
}
