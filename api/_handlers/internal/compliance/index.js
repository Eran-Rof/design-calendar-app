// api/internal/compliance/index.js
//
// GET — list all compliance documents with filters.
//   ?status=<pending_review|approved|rejected|expired|superseded>
//   ?document_type_id=<uuid>
//   ?vendor_id=<uuid>
//   ?expiring_within_days=<int>   (only approved+pending docs with expiry
//                                   between today and today+N)
// Returns raw compliance_documents rows (most-recent first), joined with
// vendor name + document type name for display.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

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
  const status = url.searchParams.get("status");
  const documentTypeId = url.searchParams.get("document_type_id");
  const vendorId = url.searchParams.get("vendor_id");
  const expiringWithinDaysRaw = url.searchParams.get("expiring_within_days");

  let query = admin
    .from("compliance_documents")
    .select("*, vendor:vendors(id,name), document_type:compliance_document_types(id,name,code,required,expiry_required)")
    .order("uploaded_at", { ascending: false });

  if (status)          query = query.eq("status", status);
  if (documentTypeId)  query = query.eq("document_type_id", documentTypeId);
  if (vendorId)        query = query.eq("vendor_id", vendorId);

  if (expiringWithinDaysRaw) {
    const n = Number(expiringWithinDaysRaw);
    if (Number.isFinite(n) && n >= 0) {
      const today = new Date().toISOString().slice(0, 10);
      const cutoff = new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
      query = query.gte("expiry_date", today).lte("expiry_date", cutoff).in("status", ["approved", "pending_review"]);
    }
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}
