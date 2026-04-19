// api/vendor/compliance/summary.js
//
// GET — returns a small object used by the vendor dashboard badge:
//   { complete: int, missing: int, expiring_soon: int, rejected: int }
//
// Same grouping logic as /api/vendor/compliance GET, but flattened to
// counts only — much cheaper for the dashboard to hit frequently.

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

  const jwt = req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
    ? req.headers.authorization.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "Authentication required" });
  const { data: userRes, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !userRes?.user) return res.status(401).json({ error: "Invalid or expired token" });

  const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", userRes.user.id).maybeSingle();
  if (!vu) return res.status(403).json({ error: "Not linked to a vendor" });

  const [typesRes, docsRes] = await Promise.all([
    admin.from("compliance_document_types").select("id, required, expiry_required").eq("active", true),
    admin.from("compliance_documents").select("document_type_id, status, expiry_date, uploaded_at").eq("vendor_id", vu.vendor_id),
  ]);
  if (typesRes.error) return res.status(500).json({ error: typesRes.error.message });
  if (docsRes.error)  return res.status(500).json({ error: docsRes.error.message });

  const types = typesRes.data || [];
  const docs = docsRes.data || [];

  const byType = new Map();
  for (const d of docs) {
    const prev = byType.get(d.document_type_id);
    if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) byType.set(d.document_type_id, d);
  }

  const now = new Date();
  const in60 = new Date(now.getTime() + 60 * 86_400_000);

  let complete = 0, missing = 0, expiring_soon = 0, rejected = 0;
  for (const t of types) {
    const d = byType.get(t.id);
    if (!d) { if (t.required) missing++; continue; }
    if (d.status === "rejected") { rejected++; continue; }
    if (d.status === "approved" && d.expiry_date) {
      const exp = new Date(d.expiry_date);
      if (exp < now) { if (t.required) missing++; continue; }
      if (exp < in60) { expiring_soon++; continue; }
    }
    if (d.status === "approved" || d.status === "pending_review") complete++;
    else if (d.status === "expired") { if (t.required) missing++; }
  }

  return res.status(200).json({ complete, missing, expiring_soon, rejected });
}
