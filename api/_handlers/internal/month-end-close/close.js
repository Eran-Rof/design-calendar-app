// api/internal/month-end-close/close
//
// POST { month: "YYYY-MM", reason } — finalize the month-end close:
//
//   1. Requires EVERY automated check to be pass and EVERY manual item to be
//      signed off (409 with the offending items otherwise), and a fresh-ish
//      checks run (409 if checks were never run).
//   2. Requires a non-empty reason and a per-user identity (resolveUserId —
//      JWT first, X-Auth-User-Id fallback).
//   3. Locks the GL period via the P5-1 gl_period_transition_status RPC →
//      status 'closed'. The RPC sets the session vars so the audit trigger
//      records actor + reason in gl_period_status_log (T11), and the
//      je_period_lock_* triggers enforce the lock from that moment.
//   4. Marks close_periods status='closed' with who/when.
//
// closed_with_closing_jes (year-end terminal) is never touched here.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller, resolveUserId } from "../../../_lib/auth.js";
import {
  MONTH_RE,
  resolveDefaultEntityId,
  resolvePeriodForMonth,
  fetchChecklistItems,
  checklistComplete,
} from "../../../_lib/accounting/closeChecklist.js";

// 60s: the close re-runs close_run_auto_checks, which can take ~18s on a cold
// buffer cache at mirror scale (695k JE lines) — see mig 20260994.
export const config = { maxDuration: 60 };

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
  if (!reason) return res.status(400).json({ error: "reason is required to close a period" });
  if (reason.length > 500) return res.status(400).json({ error: "reason must be <= 500 chars" });

  const user = await resolveUserId(req, admin);
  if (!user.ok) return res.status(user.status).json({ error: user.error });

  try {
    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const period = await resolvePeriodForMonth(admin, entityId, month);
    if (!period) return res.status(404).json({ error: `No accounting period found for ${month}` });

    if (period.status === "closed_with_closing_jes") {
      return res.status(409).json({ error: "Period is closed_with_closing_jes (year-end terminal). Cannot transition." });
    }
    if (period.status === "closed") {
      return res.status(409).json({ error: "GL period is already closed." });
    }

    const { data: cp, error: cErr } = await admin
      .from("close_periods")
      .select("id, status, checks_last_run_at")
      .eq("entity_id", entityId)
      .eq("period_id", period.id)
      .maybeSingle();
    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!cp || !cp.checks_last_run_at) {
      return res.status(409).json({ error: "Run checks first — a period cannot be closed before the automated checks have run." });
    }

    const items = await fetchChecklistItems(admin, cp.id);
    if (!checklistComplete(items)) {
      const blocking = items
        .filter((i) => (i.kind === "auto" ? i.status !== "pass" : i.status !== "signed_off"))
        .map((i) => ({ item_key: i.item_key, label: i.label, kind: i.kind, status: i.status }));
      return res.status(409).json({
        error: "Checklist incomplete — every automated check must pass and every manual item must be signed off.",
        blocking,
      });
    }

    // Lock the GL period. Actor + reason land in gl_period_status_log via the
    // RPC's session vars + AFTER UPDATE trigger (P5-1).
    const { data: updated, error: tErr } = await admin.rpc("gl_period_transition_status", {
      p_id: period.id,
      p_target_status: "closed",
      p_actor_user_id: user.authId,
      p_reason: reason,
    });
    if (tErr) return res.status(500).json({ error: tErr.message });
    if (!updated) return res.status(500).json({ error: "Transition RPC returned no row" });

    const nowIso = new Date().toISOString();
    const { error: uErr } = await admin
      .from("close_periods")
      .update({ status: "closed", closed_at: nowIso, closed_by_user_id: user.authId })
      .eq("id", cp.id);
    if (uErr) return res.status(500).json({ error: uErr.message });

    return res.status(200).json({
      month,
      period_id: period.id,
      gl_status: updated.status,
      close_status: "closed",
      closed_at: nowIso,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
