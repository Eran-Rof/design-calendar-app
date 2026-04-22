// api/vendor/bulk/:id
//
// GET — current status + progress for a bulk operation (only if owned
// by the caller's vendor). Includes a short-lived signed URL for
// result_file_url if available so the client can download the result
// CSV directly from Storage.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

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
  const idx = parts.lastIndexOf("bulk");
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
  if (!id) return res.status(400).json({ error: "Missing bulk operation id" });

  const { data: op, error } = await admin
    .from("bulk_operations")
    .select("*")
    .eq("id", id)
    .eq("vendor_id", caller.vendor_id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!op) return res.status(404).json({ error: "Not found" });

  let result_download_url = null;
  if (op.result_file_url) {
    try {
      const { data: signed } = await admin.storage
        .from("bulk-operations")
        .createSignedUrl(op.result_file_url, 300);
      result_download_url = signed?.signedUrl || null;
    } catch { /* ignore */ }
  }

  return res.status(200).json({ ...op, result_download_url });
}
