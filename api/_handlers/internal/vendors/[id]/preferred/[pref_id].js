// api/internal/vendors/:id/preferred/:pref_id
//
// DELETE — remove a preferred-vendor entry. The second path segment is
// the preferred_vendors row id (not another vendor id).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getIds(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const vIdx = parts.lastIndexOf("vendors");
  const pIdx = parts.lastIndexOf("preferred");
  return {
    vendor_id: vIdx >= 0 ? parts[vIdx + 1] : (req.query?.id || null),
    pref_id:   pIdx >= 0 ? parts[pIdx + 1] : (req.query?.pref_id || null),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { vendor_id, pref_id } = getIds(req);
  if (!vendor_id || !pref_id) return res.status(400).json({ error: "Missing vendor or preferred id" });

  const { data: row } = await admin.from("preferred_vendors").select("id, vendor_id").eq("id", pref_id).maybeSingle();
  if (!row || row.vendor_id !== vendor_id) return res.status(404).json({ error: "Not found" });

  const { error } = await admin.from("preferred_vendors").delete().eq("id", pref_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
