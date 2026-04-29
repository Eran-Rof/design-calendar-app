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

  // Batch-fetch line labels so line-level change requests render with a
  // human-readable caption (style / item number / line index) instead of
  // the raw po_line_key UUID — or no label at all.
  const lineKeys = Array.from(new Set((rows || []).map((r) => r.po_line_key).filter(Boolean)));
  const lineLabelById = new Map();
  if (lineKeys.length) {
    const { data: lines } = await admin
      .from("po_line_items")
      .select("id, line_index, item_number, description")
      .in("id", lineKeys);
    for (const l of lines || []) {
      const label = l.item_number || (l.line_index != null ? `Line ${l.line_index}` : `Line item`);
      lineLabelById.set(l.id, { label, description: l.description || null });
    }
  }

  // Look up prior reviewed requests on the same (vendor, po, phase, line,
  // field) so the caller can flag resubmissions — e.g. "previously
  // rejected on DATE". We scope to the set of (po_id, phase_name) pairs
  // currently being returned to keep the query cheap.
  const phasePoPairs = Array.from(new Set((rows || []).map((r) => `${r.po_id}::${r.phase_name}`)));
  const priorByKey = new Map(); // `${po_id}::${phase}::${line}::${field}` → array sorted desc
  if (phasePoPairs.length) {
    const poIdList = Array.from(new Set((rows || []).map((r) => r.po_id)));
    const phaseList = Array.from(new Set((rows || []).map((r) => r.phase_name)));
    const { data: priors } = await admin
      .from("tanda_milestone_change_requests")
      .select("id, po_id, phase_name, po_line_key, field_name, status, new_value, old_value, reviewed_at, reviewed_by_internal_id, review_note")
      .in("po_id", poIdList)
      .in("phase_name", phaseList)
      .in("status", ["approved", "rejected"])
      .not("reviewed_at", "is", null)
      .order("reviewed_at", { ascending: false });
    for (const p of priors || []) {
      const key = `${p.po_id}::${p.phase_name}::${p.po_line_key ?? "__master"}::${p.field_name}`;
      const arr = priorByKey.get(key) || [];
      arr.push(p);
      priorByKey.set(key, arr);
    }
  }

  const out = (rows || []).map((r) => {
    const key = `${r.po_id}::${r.phase_name}::${r.po_line_key ?? "__master"}::${r.field_name}`;
    const priors = (priorByKey.get(key) || []).filter((p) => p.id !== r.id);
    const lastRejected = priors.find((p) => p.status === "rejected") || null;
    const lineInfo = r.po_line_key ? lineLabelById.get(r.po_line_key) || null : null;
    return {
      ...r,
      vendor_name: vendorNameById.get(r.vendor_id) || "—",
      requested_by_display_name: r.requested_by_vendor_user_id ? vuNameById.get(r.requested_by_vendor_user_id) : null,
      scope: r.po_line_key ? "line" : "master",
      line_label: lineInfo?.label || null,
      line_description: lineInfo?.description || null,
      prior_reviews_count: priors.length,
      last_rejected_at: lastRejected?.reviewed_at || null,
      last_rejected_note: lastRejected?.review_note || null,
      prior_reviews: priors.slice(0, 5).map((p) => ({
        id: p.id,
        status: p.status,
        new_value: p.new_value,
        old_value: p.old_value,
        reviewed_at: p.reviewed_at,
        review_note: p.review_note,
        reviewed_by_internal_id: p.reviewed_by_internal_id,
      })),
    };
  });

  return res.status(200).json({ rows: out });
}
