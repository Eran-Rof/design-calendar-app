// api/internal/compliance/automation-rules
//
// GET  — list rules (optionally by entity_id).
// POST — create rule.
//   body: { entity_id, document_type_id, trigger_type,
//           days_before_expiry?, auto_request?, escalation_after_days?, is_active? }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

const TRIGGER_TYPES = ["expiry_approaching", "status_change", "periodic_review"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
    let q = admin.from("compliance_automation_rules")
      .select("*, document_type:compliance_document_types(id, name, code), entity:entities(id, name)")
      .order("created_at", { ascending: false });
    if (entityId) q = q.eq("entity_id", entityId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { entity_id, document_type_id, trigger_type, days_before_expiry, auto_request, escalation_after_days, is_active } = body || {};
    if (!entity_id) return res.status(400).json({ error: "entity_id required" });
    if (!document_type_id) return res.status(400).json({ error: "document_type_id required" });
    if (!TRIGGER_TYPES.includes(trigger_type)) return res.status(400).json({ error: `trigger_type must be one of ${TRIGGER_TYPES.join(", ")}` });
    if (trigger_type === "expiry_approaching" && (days_before_expiry === null || days_before_expiry === undefined)) {
      return res.status(400).json({ error: "days_before_expiry required for expiry_approaching" });
    }

    const { data, error } = await admin.from("compliance_automation_rules").insert({
      entity_id, document_type_id, trigger_type,
      days_before_expiry: days_before_expiry ?? null,
      auto_request: !!auto_request,
      escalation_after_days: escalation_after_days ?? null,
      is_active: is_active !== false,
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
