// api/internal/vendors/:id/notes
//
// GET  — all notes for this vendor (pinned first, then created_at desc).
// POST — create a note. body: { body, is_pinned?, created_by }
//
// Notes are INTERNAL ONLY — never visible to the vendor.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

function getVendorId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("vendors");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const vendorId = getVendorId(req);
  if (!vendorId) return res.status(400).json({ error: "Missing vendor id" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("vendor_notes")
      .select("*")
      .eq("vendor_id", vendorId)
      .order("is_pinned", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { body: noteBody, is_pinned, created_by } = body || {};
    if (!noteBody || !String(noteBody).trim()) return res.status(400).json({ error: "body is required" });
    if (!created_by || !String(created_by).trim()) return res.status(400).json({ error: "created_by is required" });

    const { data: vendor } = await admin.from("vendors").select("id").eq("id", vendorId).maybeSingle();
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    const { data: note, error } = await admin.from("vendor_notes").insert({
      vendor_id: vendorId,
      body: String(noteBody).trim(),
      is_pinned: !!is_pinned,
      created_by: String(created_by).trim(),
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(note);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
