// api/internal/workflow-executions
//
// GET — list executions. Filters:
//   ?entity_id=<uuid>         scope to one entity (default: all entities)
//   ?status=pending|approved|rejected|auto_approved|skipped
//   ?rule_id=<uuid>
//   ?current_approver=<role-or-email>
//   ?limit=100&offset=0
//
// Default view (no entity_id or status filter) returns pending approvals
// across all rules, triggered_at asc (oldest first) per the spec.
// Scoped / filtered queries order by triggered_at desc.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const STATUS_RANK = { pending: 4, rejected: 2, auto_approved: 1, approved: 1, skipped: 0 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
  const status = url.searchParams.get("status");
  const ruleId = url.searchParams.get("rule_id");
  const approver = url.searchParams.get("current_approver");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const defaultPendingView = !entityId && !status;

  let q = admin
    .from("workflow_executions")
    .select("*, rule:workflow_rules(id, name, trigger_event, conditions, actions)", { count: "exact" });
  if (entityId) q = q.eq("entity_id", entityId);
  if (status)   q = q.eq("status", status);
  else if (defaultPendingView) q = q.eq("status", "pending");
  if (ruleId)   q = q.eq("rule_id", ruleId);
  if (approver) q = q.eq("current_approver", approver);

  const { data, error, count } = await q
    .order("triggered_at", { ascending: defaultPendingView })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });

  const rows = (data || []).slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 0;
    const rb = STATUS_RANK[b.status] ?? 0;
    if (ra !== rb) return rb - ra;
    return defaultPendingView
      ? new Date(a.triggered_at).getTime() - new Date(b.triggered_at).getTime()
      : new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime();
  });
  return res.status(200).json({ rows, total: count || 0, limit, offset });
}
