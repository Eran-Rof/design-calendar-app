// api/internal/costing/lines/:line_id/compliance/:req_id
//
// PUT    — patch compliance row (status / notes / attachment_url / completed_at / requirement_code)
// DELETE — remove compliance row

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

const EDITABLE = ["requirement_code","status","notes","attachment_url","completed_at"];

function getReqId(req) {
  if (req.query && req.query.req_id) return req.query.req_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("compliance");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const reqId = getReqId(req);
  if (!reqId) return res.status(400).json({ error: "Missing requirement id" });

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const updates = {};
    for (const f of EDITABLE) {
      if (body && Object.prototype.hasOwnProperty.call(body, f)) updates[f] = body[f];
    }
    if (updates.requirement_code) updates.requirement_code = String(updates.requirement_code).trim().toUpperCase();
    if (updates.status && !["na","required","submitted","approved","rejected"].includes(updates.status)) {
      return res.status(400).json({ error: "invalid status" });
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No editable fields in body" });

    const { data, error } = await admin.from("costing_line_compliance")
      .update(updates).eq("id", reqId).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Compliance row not found" });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("costing_line_compliance").delete().eq("id", reqId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  return res.status(405).json({ error: "Method not allowed" });
}
