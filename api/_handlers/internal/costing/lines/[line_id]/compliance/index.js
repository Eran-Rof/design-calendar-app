// api/internal/costing/lines/:line_id/compliance
//
// GET  — list compliance rows for a line (sorted by requirement_code)
// POST — create a compliance row
//   body: { requirement_code, status?, notes?, attachment_url?, completed_at? }

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  if (req.method === "GET") {
    const { data, error } = await admin.from("costing_line_compliance")
      .select("*").eq("costing_line_id", lineId)
      .order("requirement_code", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { requirement_code, status, notes, attachment_url, completed_at, entity_id } = body || {};
    if (!requirement_code || !String(requirement_code).trim()) {
      return res.status(400).json({ error: "requirement_code is required" });
    }
    if (status && !["na","required","submitted","approved","rejected"].includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }
    const insert = {
      costing_line_id: lineId,
      requirement_code: String(requirement_code).trim().toUpperCase(),
      status: status || "required",
      notes: notes || null,
      attachment_url: attachment_url || null,
      completed_at: completed_at || null,
    };
    if (entity_id) insert.entity_id = entity_id;

    const { data, error } = await admin.from("costing_line_compliance")
      .insert(insert).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
