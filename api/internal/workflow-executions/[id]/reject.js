// api/internal/workflow-executions/:id/reject
//
// POST — reject a pending workflow execution.
//   body: { reviewer, rejection_reason }
// Fires a rejection notification to the vendor whose submission
// triggered the rule (if captured in context.vendor_id).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const rIdx = parts.lastIndexOf("reject");
  return rIdx > 0 ? parts[rIdx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing execution id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const reviewer = body?.reviewer || "Internal";
  const rejection_reason = body?.rejection_reason;
  if (!rejection_reason || !String(rejection_reason).trim()) return res.status(400).json({ error: "rejection_reason is required" });

  const { data: exec } = await admin.from("workflow_executions").select("*").eq("id", id).maybeSingle();
  if (!exec) return res.status(404).json({ error: "Execution not found" });
  if (exec.status !== "pending") return res.status(409).json({ error: `Execution is already ${exec.status}` });

  const nowIso = new Date().toISOString();
  const { error } = await admin.from("workflow_executions").update({
    status: "rejected",
    rejected_by: reviewer,
    rejection_reason: String(rejection_reason).trim(),
    resolved_at: nowIso,
  }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  const ctx = exec.metadata?.context || {};
  if (ctx.vendor_id) {
    try {
      const origin = `https://${req.headers.host}`;
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "workflow_rejected",
          title: `Rejected: ${exec.metadata?.rule_name || "Workflow approval"}`,
          body: `Your ${ctx.entity_type || "submission"} was rejected by ${reviewer}.\n\nReason: ${rejection_reason}`,
          link: "/vendor",
          metadata: { execution_id: id, rule_id: exec.rule_id, reason: rejection_reason, ...ctx },
          recipient: { vendor_id: ctx.vendor_id },
          dedupe_key: `workflow_rejected_${id}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* non-blocking */ }
  }

  return res.status(200).json({ ok: true, id, status: "rejected" });
}
