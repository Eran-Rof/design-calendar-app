// api/internal/compliance/document-types.js
//
// GET  — list all compliance document types (active + inactive)
// POST — create a new document type
//         body: { name, description, required, expiry_required, reminder_days_before }
//         code is auto-derived from name (lowercased, non-alnum -> _)
//
// "Internal auth" in the spec — these endpoints run with the service role
// and are not exposed to unauthenticated external callers via CORS
// (wildcard is intentional because the internal app calls them from the
// same origin; protect via network/firewall or add a shared-secret header
// if you need stricter auth).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("compliance_document_types")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { name, description, required = true, expiry_required = true, reminder_days_before = 30 } = body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });

    const code = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!code) return res.status(400).json({ error: "name must contain at least one letter or digit" });

    const { data, error } = await admin
      .from("compliance_document_types")
      .insert({ code, name, description: description || null, required, expiry_required, reminder_days_before, active: true })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "A document type with this name already exists" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
