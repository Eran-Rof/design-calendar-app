// api/internal/workflow-rules/:id
//
// PUT    — update a rule (name, conditions, actions, is_active).
//          body shape identical to POST but every field is optional.
// DELETE — soft-delete by setting is_active=false (hard delete cascades
//          workflow_executions; use only if you really mean it via
//          ?hard=true).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

const TRIGGER_EVENTS = [
  "po_issued", "invoice_submitted", "invoice_approved", "shipment_created",
  "compliance_expired", "dispute_opened", "anomaly_detected",
  "onboarding_submitted", "contract_signed", "rfq_awarded",
];
const CONDITION_OPS = ["gt", "lt", "gte", "lte", "eq", "neq", "contains", "in"];
const ACTION_TYPES  = ["require_approval", "notify", "auto_approve", "create_task", "webhook"];

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("workflow-rules");
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
    if (body?.name !== undefined)        updates.name = String(body.name).trim();
    if (body?.trigger_event !== undefined) {
      if (!TRIGGER_EVENTS.includes(body.trigger_event)) return res.status(400).json({ error: "Invalid trigger_event" });
      updates.trigger_event = body.trigger_event;
    }
    if (body?.conditions !== undefined) {
      if (!Array.isArray(body.conditions)) return res.status(400).json({ error: "conditions must be an array" });
      for (const c of body.conditions) {
        if (!c?.field || !CONDITION_OPS.includes(c.op)) return res.status(400).json({ error: `Invalid condition: ${JSON.stringify(c)}` });
      }
      updates.conditions = body.conditions;
    }
    if (body?.actions !== undefined) {
      if (!Array.isArray(body.actions) || body.actions.length === 0) return res.status(400).json({ error: "actions must be non-empty" });
      for (const a of body.actions) {
        if (!ACTION_TYPES.includes(a?.type)) return res.status(400).json({ error: `Invalid action type: ${a?.type}` });
        if (a.type === "webhook" && !a.url) return res.status(400).json({ error: "webhook action requires url" });
      }
      updates.actions = body.actions;
    }
    if (body?.is_active !== undefined) updates.is_active = !!body.is_active;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields" });
    updates.updated_at = new Date().toISOString();

    const { error } = await admin.from("workflow_rules").update(updates).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const hard = url.searchParams.get("hard") === "true";
    if (hard) {
      const { error } = await admin.from("workflow_rules").delete().eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const { error } = await admin.from("workflow_rules").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ ok: true, id, hard });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
