// api/_lib/workflow.js
//
// Workflow rule engine. Callers fire events; the engine loads matching
// active rules, evaluates conditions, executes actions, and optionally
// blocks the calling event until an approval lands.
//
//   fireWorkflowEvent({ admin, event, entity_id, context, origin })
//     → { blocked, blocking_execution_id, results: [...] }
//
// Condition shape: [{ field, op, value }]  (all must pass — AND)
// Condition ops:   gt | lt | gte | lte | eq | neq | contains | in
// Action shape:    { type, ...params }
// Action types:
//   require_approval  { approver_role?: 'finance_manager' | ...,
//                       approver_email?: '...' }
//   notify            { to_role?, to_email?, to_vendor?: true, message? }
//   auto_approve      {}
//   create_task       { assigned_role?, title?, description? }
//   webhook           { url, headers? }
//
// Trigger events (the source of truth list — keep in sync with the
// workflow_rules CHECK constraint):
//   po_issued | invoice_submitted | invoice_approved | shipment_created
//   | compliance_expired | dispute_opened | anomaly_detected
//   | onboarding_submitted | contract_signed | rfq_awarded

const DEFAULT_ROLE_EMAILS = {
  finance_manager:    process.env.INTERNAL_FINANCE_EMAILS,
  procurement:        process.env.INTERNAL_PROCUREMENT_EMAILS,
  compliance:         process.env.INTERNAL_COMPLIANCE_EMAILS,
  vendor_ops:         process.env.INTERNAL_VENDOR_ALERT_EMAILS,
  edi_ops:            process.env.INTERNAL_EDI_EMAILS,
  disputes_team:      process.env.INTERNAL_DISPUTE_EMAILS,
  onboarding_team:    process.env.INTERNAL_ONBOARDING_EMAILS,
};

function roleEmails(role) {
  const raw = DEFAULT_ROLE_EMAILS[role] || process.env.INTERNAL_COMPLIANCE_EMAILS || "";
  return raw.split(",").map((e) => e.trim()).filter(Boolean);
}

function evalOp(op, a, b) {
  if (op === "gt")       return Number(a) >  Number(b);
  if (op === "lt")       return Number(a) <  Number(b);
  if (op === "gte")      return Number(a) >= Number(b);
  if (op === "lte")      return Number(a) <= Number(b);
  if (op === "eq")       return a === b;
  if (op === "neq")      return a !== b;
  if (op === "contains") return String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase());
  if (op === "in")       return Array.isArray(b) && b.some((v) => v === a);
  return false;
}

export function evaluateConditions(conditions, context) {
  if (!conditions || conditions.length === 0) return true;
  for (const c of conditions) {
    if (!c || !c.field) continue;
    const v = getField(context, c.field);
    if (!evalOp(c.op, v, c.value)) return false;
  }
  return true;
}

function getField(ctx, path) {
  // Dot-path lookup: "vendor.health_score" → ctx.vendor.health_score
  if (!ctx) return undefined;
  if (!path.includes(".")) return ctx[path];
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), ctx);
}

async function insertExecution(admin, { rule_id, entity_id, event, context, status, current_approver = null, metadata = null }) {
  const payload = {
    rule_id,
    entity_id,
    trigger_entity_type: context.entity_type || event,
    trigger_entity_id: context.entity_id || null,
    status,
    current_approver,
    triggered_at: new Date().toISOString(),
    metadata: metadata || { event, context },
  };
  if (status !== "pending") payload.resolved_at = new Date().toISOString();
  const { data } = await admin.from("workflow_executions").insert(payload).select("id").single();
  return data?.id || null;
}

async function sendNotification(origin, email, { title, body, metadata = {}, event_type = "workflow_notification", recipient }) {
  if (!origin) return;
  try {
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type,
        title,
        body,
        link: "/",
        metadata,
        recipient: recipient || { internal_id: "workflow", email },
        dedupe_key: `workflow_${event_type}_${email || "vendor"}_${Date.now()}`,
        email: !!email,
      }),
    });
  } catch { /* non-blocking */ }
}

async function executeAction(action, context, { admin, origin, rule, event, entity_id }) {
  const type = action?.type;
  if (type === "require_approval") {
    const approverRole = action.approver_role || "finance_manager";
    const approverEmail = action.approver_email || roleEmails(approverRole)[0] || null;
    const execId = await insertExecution(admin, {
      rule_id: rule.id, entity_id, event, context,
      status: "pending",
      current_approver: approverEmail || approverRole,
      metadata: { approver_role: approverRole, rule_name: rule.name, context },
    });
    for (const email of roleEmails(approverRole)) {
      await sendNotification(origin, email, {
        event_type: "workflow_approval_required",
        title: `Approval required: ${rule.name}`,
        body: `Rule '${rule.name}' triggered on event '${event}'. Open the workflow executions view to approve or reject.`,
        metadata: { execution_id: execId, rule_id: rule.id, event, ...context },
      });
    }
    return { type, status: "pending", execution_id: execId };
  }

  if (type === "auto_approve") {
    const execId = await insertExecution(admin, {
      rule_id: rule.id, entity_id, event, context,
      status: "auto_approved",
      metadata: { rule_name: rule.name, context },
    });
    return { type, status: "auto_approved", execution_id: execId };
  }

  if (type === "notify") {
    const emails = new Set();
    if (action.to_email) emails.add(action.to_email);
    if (action.to_role) for (const e of roleEmails(action.to_role)) emails.add(e);
    const title = action.title || `Workflow: ${rule.name}`;
    const body  = action.message || `Triggered on '${event}'`;
    const metadata = { rule_id: rule.id, event, ...context };

    for (const email of emails) {
      await sendNotification(origin, email, { event_type: "workflow_notification", title, body, metadata });
    }
    if (action.to_vendor && context.vendor_id) {
      await sendNotification(origin, null, {
        event_type: "workflow_notification", title, body, metadata,
        recipient: { vendor_id: context.vendor_id },
      });
    }
    return { type, status: "sent", recipients: [...emails] };
  }

  if (type === "webhook") {
    if (!action.url) return { type, status: "error", error: "webhook url missing" };
    try {
      const resp = await fetch(action.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(action.headers || {}) },
        body: JSON.stringify({ rule_id: rule.id, rule_name: rule.name, event, ...context }),
      });
      return { type, status: resp.ok ? "sent" : "error", http_status: resp.status };
    } catch (e) {
      return { type, status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (type === "create_task") {
    const execId = await insertExecution(admin, {
      rule_id: rule.id, entity_id, event, context,
      status: "skipped",
      metadata: { create_task: true, assigned_role: action.assigned_role, title: action.title, description: action.description, context },
    });
    return { type, status: "task_queued", execution_id: execId };
  }

  return { type, status: "error", error: `Unknown action type: ${type}` };
}

export async function fireWorkflowEvent({ admin, event, entity_id, context = {}, origin = null }) {
  if (!event) return { blocked: false, results: [] };
  if (!entity_id) {
    // Best-effort fallback to default entity
    const { data: def } = await admin.from("entities").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
    entity_id = def?.id || null;
  }
  if (!entity_id) return { blocked: false, results: [] };

  const { data: rules } = await admin
    .from("workflow_rules")
    .select("*")
    .eq("trigger_event", event)
    .eq("entity_id", entity_id)
    .eq("is_active", true);

  let blocked = false;
  let blockingExecutionId = null;
  const results = [];

  for (const rule of rules || []) {
    if (!evaluateConditions(rule.conditions || [], context)) continue;
    for (const action of rule.actions || []) {
      const result = await executeAction(action, context, { admin, origin, rule, event, entity_id });
      results.push({ rule_id: rule.id, rule_name: rule.name, action_type: action.type, result });
      if (result.status === "pending" && !blocked) {
        blocked = true;
        blockingExecutionId = result.execution_id;
      }
    }
  }

  return { blocked, blocking_execution_id: blockingExecutionId, results };
}
