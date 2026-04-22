// api/vendor/edi/status
//
// GET — EDI message history for the caller's vendor, last 30 days,
// both directions. Used by the vendor portal EDI status view.
//
// Response:
//   {
//     counts: { inbound, outbound, error, pending },
//     rows: [ { id, direction, transaction_set, status, created_at,
//               error_message, interchange_id } ]
//   }
//
// Raw EDI content is NOT returned to vendors — they inspect the
// parsed entity (PO, invoice, shipment) via the portal directly.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("edi_messages")
    .select("id, direction, transaction_set, status, interchange_id, error_message, created_at")
    .eq("vendor_id", caller.vendor_id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const counts = {
    inbound:  rows.filter((r) => r.direction === "inbound").length,
    outbound: rows.filter((r) => r.direction === "outbound").length,
    error:    rows.filter((r) => r.status === "error").length,
    pending:  rows.filter((r) => r.status === "received").length,
  };

  return res.status(200).json({ counts, rows });
}
