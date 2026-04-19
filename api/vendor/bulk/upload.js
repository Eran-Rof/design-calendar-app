// api/vendor/bulk/upload
//
// POST — vendor kicks off a bulk operation.
//   body: { type, input_file_url, filename?, total_rows? }
//
// The client pre-uploads the CSV to the 'bulk-operations' Storage bucket
// under {vendor_id}/... and passes the resulting path as input_file_url.
// This avoids hitting Vercel body-size limits and keeps RLS enforcement on
// the bucket.
//
// Side effects:
//   - Creates bulk_operations row (status='queued')
//   - Fire-and-forget POST /api/internal/bulk/process to start processing
//   - Returns { bulk_operation_id }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const ALLOWED_TYPES = ["po_acknowledge", "catalog_update", "invoice_submit"];

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin
      .from("vendor_users").select("id, vendor_id, display_name").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id, email: data.user.email } : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { type, input_file_url, filename, total_rows } = body || {};

  if (!type || !ALLOWED_TYPES.includes(type))
    return res.status(400).json({ error: `type must be one of ${ALLOWED_TYPES.join(", ")}` });
  if (!input_file_url || typeof input_file_url !== "string")
    return res.status(400).json({ error: "input_file_url is required (Storage path under bulk-operations/{vendor_id}/...)" });

  // Enforce the vendor folder prefix so one vendor can't point at another's file.
  const prefix = `${caller.vendor_id}/`;
  if (!input_file_url.startsWith(prefix))
    return res.status(403).json({ error: "input_file_url must live under your vendor folder" });

  const { data: op, error: opErr } = await admin.from("bulk_operations").insert({
    vendor_id: caller.vendor_id,
    type,
    status: "queued",
    input_file_url,
    total_rows: Number.isFinite(Number(total_rows)) ? Number(total_rows) : 0,
    created_by: caller.id,
    error_summary: filename ? { filename } : null,
  }).select("*").single();
  if (opErr) return res.status(500).json({ error: opErr.message });

  // Fire-and-forget to the processor
  try {
    const origin = `https://${req.headers.host}`;
    fetch(`${origin}/api/internal/bulk/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bulk_operation_id: op.id }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(201).json({ bulk_operation_id: op.id });
}
