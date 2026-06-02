// api/internal/gl-periods/:id/reopen
//
// POST. Body: {
//   actor_user_id: <uuid>,          // REQUIRED
//   reason:        <text>,          // REQUIRED, non-empty
// }
//
// 1. Resolves the period.
// 2. Rejects 409 if status is 'closed_with_closing_jes' (terminal).
// 3. Requires actor to hold role='admin' on the entity (403 otherwise).
// 4. Calls gl_period_transition_status RPC: closed → soft_close, also reopens
//    soft_close → open as a convenience path. Audit log captures reason.
// 5. Enqueues 'gl_period_reopened' notification with the reason in the body.
//
// Tangerine P5-1.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// closed_with_closing_jes is one-way terminal — NOT in this map.
const REOPEN_TARGET = {
  closed:     "soft_close",
  soft_close: "open",
};

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validateBody(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.actor_user_id || !UUID_RE.test(String(body.actor_user_id))) {
    return { error: "actor_user_id (uuid) is required" };
  }
  if (!body.reason || !String(body.reason).trim()) {
    return { error: "reason is required (operator note explaining the reopen)" };
  }
  const reason = String(body.reason).trim();
  if (reason.length > 500) return { error: "reason must be <= 500 chars" };
  return {
    data: {
      actor_user_id: String(body.actor_user_id),
      reason,
    },
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: period, error: pErr } = await admin
    .from("gl_periods")
    .select("id, entity_id, fiscal_year, period_number, status")
    .eq("id", id)
    .maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: "Period not found" });

  if (period.status === "closed_with_closing_jes") {
    return res.status(409).json({
      error: "Period is closed_with_closing_jes (set by year-end close). Terminal — cannot reopen.",
    });
  }

  const target = REOPEN_TARGET[period.status];
  if (!target) {
    return res.status(409).json({
      error: `Cannot reopen a period in status '${period.status}'. Only 'closed' and 'soft_close' are reopenable.`,
    });
  }

  // Admin authorization on this entity.
  const { data: roleRow, error: rErr } = await admin
    .from("entity_users")
    .select("role")
    .eq("auth_id", v.data.actor_user_id)
    .eq("entity_id", period.entity_id)
    .maybeSingle();
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (!roleRow || roleRow.role !== "admin") {
    return res.status(403).json({
      error: "actor must hold role='admin' on this entity to reopen a closed period",
    });
  }

  // Atomic transition.
  const { data: updated, error: upErr } = await admin.rpc("gl_period_transition_status", {
    p_id: id,
    p_target_status: target,
    p_actor_user_id: v.data.actor_user_id,
    p_reason: v.data.reason,
  });
  if (upErr) return res.status(500).json({ error: upErr.message });
  if (!updated) return res.status(500).json({ error: "Transition RPC returned no row" });

  // Notification.
  try {
    await enqueueNotification(admin, {
      entity_id: period.entity_id,
      kind: "gl_period_reopened",
      severity: "warn",
      subject: `Period ${period.fiscal_year}-${String(period.period_number).padStart(2, "0")} reopened`,
      body: `Period ${period.fiscal_year}-${String(period.period_number).padStart(2, "0")} reopened from '${period.status}' back to '${target}'. Reason: ${v.data.reason}`,
      context_table: "gl_periods",
      context_id: period.id,
      recipient_roles: ["admin", "accountant"],
      created_by_user_id: v.data.actor_user_id,
    });
  } catch { /* non-fatal */ }

  return res.status(200).json({
    period_id: id,
    from: period.status,
    to: target,
    period: updated,
  });
}
