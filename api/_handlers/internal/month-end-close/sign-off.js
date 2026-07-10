// api/internal/month-end-close/sign-off
//
// POST { month: "YYYY-MM", item_key, note, undo? } — sign off (or revert) a
// MANUAL checklist item.
//
//   • Sign-off requires a non-empty note and a per-user identity: JWT first,
//     X-Auth-User-Id header fallback (resolveUserId — the personalization
//     pattern from feedback_personalization_jwt_fallback). Stores who + when.
//   • undo=true reverts a signed-off item to pending (note required — it is
//     stored so the trail explains the reversal; the T11 row_changes audit
//     trigger on close_checklist_items keeps the full before/after).
//   • Auto items cannot be signed off (400) — they are machine verdicts.
//   • Rejected once the close period is 'closed' (reopen first).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller, resolveUserId } from "../../../_lib/auth.js";
import {
  MONTH_RE,
  MANUAL_KEYS,
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
  const itemKey = String(body?.item_key || "").trim();
  const note = String(body?.note || "").trim();
  const undo = body?.undo === true;

  if (!MONTH_RE.test(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  if (!MANUAL_KEYS.has(itemKey)) return res.status(400).json({ error: "item_key is not a manual checklist item" });
  if (!note) return res.status(400).json({ error: "note is required (what was reviewed / why reverted)" });
  if (note.length > 500) return res.status(400).json({ error: "note must be <= 500 chars" });

  // Per-user identity — who is signing.
  const user = await resolveUserId(req, admin);
  if (!user.ok) return res.status(user.status).json({ error: user.error });

  try {
    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const period = await resolvePeriodForMonth(admin, entityId, month);
    if (!period) return res.status(404).json({ error: `No accounting period found for ${month}` });

    const { data: cp, error: cErr } = await admin
      .from("close_periods")
      .select("id, status")
      .eq("entity_id", entityId)
      .eq("period_id", period.id)
      .maybeSingle();
    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!cp) return res.status(409).json({ error: "Run checks first — the close checklist for this month has not been started." });
    if (cp.status === "closed") {
      return res.status(409).json({ error: "Period close is finalized. Reopen the period before changing sign-offs." });
    }

    const { data: item, error: iErr } = await admin
      .from("close_checklist_items")
      .select("id, kind, status")
      .eq("close_period_id", cp.id)
      .eq("item_key", itemKey)
      .maybeSingle();
    if (iErr) return res.status(500).json({ error: iErr.message });
    if (!item) return res.status(404).json({ error: "Checklist item not found — run checks to seed the list." });
    if (item.kind !== "manual") return res.status(400).json({ error: "Only manual items can be signed off." });

    const patch = undo
      ? { status: "pending", signed_off_by: null, signed_off_at: null, note }
      : { status: "signed_off", signed_off_by: user.authId, signed_off_at: new Date().toISOString(), note };

    const { data: updated, error: uErr } = await admin
      .from("close_checklist_items")
      .update(patch)
      .eq("id", item.id)
      .select("id, item_key, label, kind, status, signed_off_at, note")
      .single();
    if (uErr) return res.status(500).json({ error: uErr.message });

    return res.status(200).json({ month, item: updated, undo });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
