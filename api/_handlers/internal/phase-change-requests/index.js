// api/internal/phase-change-requests
//
// GET — list vendor phase change requests with vendor/PO context, joined
//       with phase notes counts. Optional ?status=pending|approved|rejected|all
//       (default: pending), ?vendor_id=<uuid>, ?limit=100.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const status = (url.searchParams.get("status") || "pending").toLowerCase();
  const vendorFilter = url.searchParams.get("vendor_id");
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);

  let q = admin
    .from("tanda_milestone_change_requests")
    .select("id, vendor_id, po_id, po_number, phase_name, field_name, old_value, new_value, status, requested_at, reviewed_at, reviewed_by_internal_id, review_note, po_line_key, requested_by_vendor_user_id")
    .order("requested_at", { ascending: false })
    .limit(limit);
  if (status !== "all") q = q.eq("status", status);
  if (vendorFilter) q = q.eq("vendor_id", vendorFilter);

  const { data: rows, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Batch-fetch vendor names
  const vendorIds = Array.from(new Set((rows || []).map((r) => r.vendor_id)));
  const vendorNameById = new Map();
  if (vendorIds.length) {
    const { data: vendors } = await admin.from("vendors").select("id, name, legacy_blob_id").in("id", vendorIds);
    for (const v of vendors || []) vendorNameById.set(v.id, v.name || v.legacy_blob_id || "—");
  }

  // Batch-fetch vendor_user display names
  const vuIds = Array.from(new Set((rows || []).map((r) => r.requested_by_vendor_user_id).filter(Boolean)));
  const vuNameById = new Map();
  if (vuIds.length) {
    const { data: vus } = await admin.from("vendor_users").select("id, display_name").in("id", vuIds);
    for (const vu of vus || []) vuNameById.set(vu.id, vu.display_name || "—");
  }

  const out = (rows || []).map((r) => ({
    ...r,
    vendor_name: vendorNameById.get(r.vendor_id) || "—",
    requested_by_display_name: r.requested_by_vendor_user_id ? vuNameById.get(r.requested_by_vendor_user_id) : null,
  }));

  return res.status(200).json({ rows: out });
}
