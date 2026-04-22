// api/internal/compliance/audit-trail
//
// GET — audit trail across all vendors.
//   ?vendor_id=&document_type_id=&action=&from=&to=&limit=&offset=

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

  const url = new URL(req.url, `https://${req.headers.host}`);
  const vendorId = url.searchParams.get("vendor_id");
  const docTypeId = url.searchParams.get("document_type_id");
  const action = url.searchParams.get("action");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  let q = admin.from("compliance_audit_trail")
    .select("*, vendor:vendors(id, name), document:compliance_documents(id, document_type_id, document_type:compliance_document_types(id, name, code))", { count: "exact" })
    .order("created_at", { ascending: false });
  if (vendorId) q = q.eq("vendor_id", vendorId);
  if (action) q = q.eq("action", action);
  if (from) q = q.gte("created_at", from);
  if (to)   q = q.lte("created_at", to);

  const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });

  // document_type_id filter is applied client-side (nested field)
  let rows = data || [];
  if (docTypeId) rows = rows.filter((r) => r.document?.document_type_id === docTypeId);

  return res.status(200).json({ rows, total: count || 0, limit, offset });
}
