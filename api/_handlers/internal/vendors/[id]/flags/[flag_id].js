// api/internal/vendors/:id/flags/:flag_id
//
// PUT — update flag status.
//   body: { status: 'acknowledged' | 'resolved', resolved_by?, resolution_notes? }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getIds(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const vIdx = parts.lastIndexOf("vendors");
  const fIdx = parts.lastIndexOf("flags");
  return {
    vendor_id: vIdx >= 0 ? parts[vIdx + 1] : (req.query?.id || null),
    flag_id:   fIdx >= 0 ? parts[fIdx + 1] : (req.query?.flag_id || null),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { vendor_id, flag_id } = getIds(req);
  if (!vendor_id || !flag_id) return res.status(400).json({ error: "Missing vendor or flag id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { status, resolved_by, resolution_notes } = body || {};

  if (!status || !["acknowledged", "resolved"].includes(status))
    return res.status(400).json({ error: "status must be acknowledged or resolved" });

  const updates = { status, updated_at: new Date().toISOString() };
  if (status === "resolved") {
    updates.resolved_at = new Date().toISOString();
    updates.resolved_by = resolved_by || "Internal";
    if (resolution_notes !== undefined) updates.resolution_notes = resolution_notes;
  }

  const { data: existing } = await admin
    .from("vendor_flags").select("id, vendor_id").eq("id", flag_id).maybeSingle();
  if (!existing || existing.vendor_id !== vendor_id) return res.status(404).json({ error: "Flag not found" });

  const { error } = await admin.from("vendor_flags").update(updates).eq("id", flag_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id: flag_id, status });
}
