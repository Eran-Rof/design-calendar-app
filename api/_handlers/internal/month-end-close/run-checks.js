// api/internal/month-end-close/run-checks
//
// POST { month: "YYYY-MM" } — run the automated month-end tie-out battery for
// one period and persist the results:
//
//   1. Resolve the gl_periods row for the month.
//   2. Ensure the close_periods row exists (open → in_close on first run).
//   3. Seed the manual sign-off items (idempotent).
//   4. Call the close_run_auto_checks SQL RPC (migration 20260972000000) —
//      all tie-out math happens in SQL (no PostgREST row caps); semantics
//      mirror api/_lib/accounting/tieouts.js (#1665).
//   5. Upsert one kind=auto checklist row per check with the numbers behind
//      the verdict in detail jsonb.
//
// NEVER changes gl_periods status — closing is a separate explicit action.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import {
  MONTH_RE,
  resolveDefaultEntityId,
  resolvePeriodForMonth,
  ensureClosePeriod,
  seedManualItems,
  upsertAutoItems,
  fetchChecklistItems,
  resolveSignerLabels,
  checklistComplete,
} from "../../../_lib/accounting/closeChecklist.js";

export const config = { maxDuration: 60 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID");
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
  if (!MONTH_RE.test(month)) {
    return res.status(400).json({ error: "month must be YYYY-MM" });
  }

  try {
    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const period = await resolvePeriodForMonth(admin, entityId, month);
    if (!period) return res.status(404).json({ error: `No accounting period found for ${month}` });

    const cp = await ensureClosePeriod(admin, entityId, period);
    await seedManualItems(admin, entityId, cp.id);

    const { data: rpcResult, error: rpcErr } = await admin.rpc("close_run_auto_checks", {
      p_entity_id: entityId,
      p_period_id: period.id,
    });
    if (rpcErr) return res.status(500).json({ error: `close_run_auto_checks failed: ${rpcErr.message}` });

    const upserted = await upsertAutoItems(admin, entityId, cp.id, rpcResult);

    // Stamp the run; a period still 'open' moves to 'in_close' (checks have
    // started). NEVER touches gl_periods.
    const patch = { checks_last_run_at: new Date().toISOString() };
    if (cp.status === "open") patch.status = "in_close";
    const { error: uErr } = await admin.from("close_periods").update(patch).eq("id", cp.id);
    if (uErr) return res.status(500).json({ error: uErr.message });

    const items = await resolveSignerLabels(admin, await fetchChecklistItems(admin, cp.id));
    return res.status(200).json({
      month,
      period_id: period.id,
      gl_status: period.status,
      close_status: patch.status || cp.status,
      checks_run: upserted,
      ran_at: rpcResult?.ran_at || null,
      items,
      ready_to_close: checklistComplete(items),
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
