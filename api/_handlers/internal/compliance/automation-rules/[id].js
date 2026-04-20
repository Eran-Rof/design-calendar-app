// api/internal/compliance/automation-rules/:id
//
// PUT    — update rule (auto_request, escalation_after_days, is_active, days_before_expiry).
// DELETE — soft delete by setting is_active=false.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("automation-rules");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing rule id" });

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const updates = {};
    for (const k of ["auto_request", "escalation_after_days", "is_active", "days_before_expiry"]) {
      if (body?.[k] !== undefined) updates[k] = body[k];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields" });
    updates.updated_at = new Date().toISOString();
    const { error } = await admin.from("compliance_automation_rules").update(updates).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("compliance_automation_rules")
      .update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, id });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
