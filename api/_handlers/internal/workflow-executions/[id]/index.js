// api/internal/workflow-executions/:id
//
// GET — full execution detail with rule, trigger context, status.
// PUT — legacy single-endpoint resolve (kept for backwards compat):
//         body: { action: 'approve' | 'reject', reviewer, rejection_reason? }
//       Prefer the dedicated /approve and /reject endpoints.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("workflow-executions");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing execution id" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("workflow_executions")
      .select("*, rule:workflow_rules(id, name, trigger_event, conditions, actions, entity_id), entity:entities(id, name, slug)")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Execution not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { action, reviewer, rejection_reason } = body || {};
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be approve or reject" });

    const { data: exec } = await admin.from("workflow_executions").select("*").eq("id", id).maybeSingle();
    if (!exec) return res.status(404).json({ error: "Execution not found" });
    if (exec.status !== "pending") return res.status(409).json({ error: `Execution is already ${exec.status}` });

    const nowIso = new Date().toISOString();
    const updates = { status: action === "approve" ? "approved" : "rejected", resolved_at: nowIso };
    if (action === "approve") updates.approved_by = reviewer || "Internal";
    else {
      updates.rejected_by = reviewer || "Internal";
      updates.rejection_reason = rejection_reason || null;
    }

    const { error } = await admin.from("workflow_executions").update(updates).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, id, status: updates.status });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
