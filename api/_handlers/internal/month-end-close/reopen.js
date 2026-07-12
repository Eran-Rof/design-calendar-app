// api/internal/month-end-close/reopen
//
// POST { month: "YYYY-MM", reason } — reopen a closed month.
//
//   • reason is MANDATORY; actor identity via resolveUserId (JWT first,
//     X-Auth-User-Id fallback).
//   • Actor must hold role='admin' on the entity (same bar as the P5-1
//     gl-periods reopen handler).
//   • GL period returns to 'open' via gl_period_transition_status (actor +
//     reason audit-logged in gl_period_status_log); the close_periods row
//     drops back to 'in_close' — the checklist survives, sign-offs intact,
//     so the re-close is a review, not a restart.
//   • closed_with_closing_jes (year-end terminal) can never be reopened.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller, resolveUserId } from "../../../_lib/auth.js";
import {
  MONTH_RE,
  resolveDefaultEntityId,
  resolvePeriodForMonth,
} from "../../../_lib/accounting/closeChecklist.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const month = String(body?.month || "").trim();
  const reason = String(body?.reason || "").trim();
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  if (!reason) return res.status(400).json({ error: "reason is required to reopen a period" });
  if (reason.length > 500) return res.status(400).json({ error: "reason must be <= 500 chars" });

  const user = await resolveUserId(req, admin);
  if (!user.ok) return res.status(user.status).json({ error: user.error });

  try {
    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const period = await resolvePeriodForMonth(admin, entityId, month);
    if (!period) return res.status(404).json({ error: `No accounting period found for ${month}` });

    if (period.status === "closed_with_closing_jes") {
      return res.status(409).json({ error: "Period is closed_with_closing_jes (year-end terminal). Cannot reopen." });
    }
    if (period.status === "open") {
      return res.status(409).json({ error: "GL period is already open." });
    }

    // Admin authorization on this entity — reopening a closed month is the
    // most sensitive period action (same bar as the P5-1 reopen handler).
    const { data: roleRow, error: rErr } = await admin
      .from("entity_users")
      .select("role")
      .eq("auth_id", user.authId)
      .eq("entity_id", entityId)
      .maybeSingle();
    if (rErr) return res.status(500).json({ error: rErr.message });
    if (!roleRow || roleRow.role !== "admin") {
      return res.status(403).json({ error: "Reopening a closed period requires the admin role on this entity." });
    }

    const { data: updated, error: tErr } = await admin.rpc("gl_period_transition_status", {
      p_id: period.id,
      p_target_status: "open",
      p_actor_user_id: user.authId,
      p_reason: reason,
    });
    if (tErr) return res.status(500).json({ error: tErr.message });
    if (!updated) return res.status(500).json({ error: "Transition RPC returned no row" });

    // The checklist survives; the close period goes back to in_close.
    const nowIso = new Date().toISOString();
    const { error: uErr } = await admin
      .from("close_periods")
      .update({ status: "in_close", reopened_at: nowIso, reopened_by_user_id: user.authId })
      .eq("entity_id", entityId)
      .eq("period_id", period.id);
    if (uErr) return res.status(500).json({ error: uErr.message });

    return res.status(200).json({
      month,
      period_id: period.id,
      gl_status: updated.status,
      close_status: "in_close",
      reopened_at: nowIso,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
