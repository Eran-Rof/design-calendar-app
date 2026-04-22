// api/internal/workflow-rules
//
// GET  — list rules for an entity (?entity_id=<uuid>, required).
//        ?trigger_event, ?is_active filter further.
// POST — create rule.
//   body: {
//     entity_id, name, trigger_event,
//     conditions: [{ field, op, value }],
//     actions:    [{ type, ...params }],
//     is_active?: boolean (default true),
//     created_by?: string
//   }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

const TRIGGER_EVENTS = [
  "po_issued", "invoice_submitted", "invoice_approved", "shipment_created",
  "compliance_expired", "dispute_opened", "anomaly_detected",
  "onboarding_submitted", "contract_signed", "rfq_awarded",
];
const CONDITION_OPS = ["gt", "lt", "gte", "lte", "eq", "neq", "contains", "in"];
const ACTION_TYPES  = ["require_approval", "notify", "auto_approve", "create_task", "webhook"];

function validateRuleBody(body) {
  const { entity_id, name, trigger_event, conditions = [], actions = [] } = body || {};
  if (!entity_id) return "entity_id is required";
  if (!name || !String(name).trim()) return "name is required";
  if (!TRIGGER_EVENTS.includes(trigger_event)) return `trigger_event must be one of: ${TRIGGER_EVENTS.join(", ")}`;
  if (!Array.isArray(conditions)) return "conditions must be an array";
  for (const c of conditions) {
    if (!c?.field || !CONDITION_OPS.includes(c.op)) return `Invalid condition: ${JSON.stringify(c)}`;
  }
  if (!Array.isArray(actions) || actions.length === 0) return "actions must be a non-empty array";
  for (const a of actions) {
    if (!ACTION_TYPES.includes(a?.type)) return `Invalid action type: ${a?.type}`;
    if (a.type === "webhook" && !a.url) return "webhook action requires url";
  }
  return null;
}

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
    if (!entityId) return res.status(400).json({ error: "entity_id query or X-Entity-ID header required" });
    const event = url.searchParams.get("trigger_event");
    const active = url.searchParams.get("is_active");

    let q = admin.from("workflow_rules").select("*, entity:entities(id, name, slug)").eq("entity_id", entityId);
    if (event)  q = q.eq("trigger_event", event);
    if (active !== null && active !== undefined && active !== "") q = q.eq("is_active", active === "true");
    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const err = validateRuleBody(body);
    if (err) return res.status(400).json({ error: err });

    const { entity_id, name, trigger_event, conditions, actions, is_active, created_by } = body;
    const { data: e } = await admin.from("entities").select("id").eq("id", entity_id).maybeSingle();
    if (!e) return res.status(400).json({ error: "entity_id not found" });

    const { data, error } = await admin.from("workflow_rules").insert({
      entity_id,
      name: String(name).trim(),
      trigger_event,
      conditions: conditions || [],
      actions,
      is_active: is_active !== false,
      created_by: created_by || null,
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
