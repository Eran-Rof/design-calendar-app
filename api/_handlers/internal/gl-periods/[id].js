// api/internal/gl-periods/[id]
//
// GET    — fetch one period + posted JE count.
// PATCH  — status transitions ONLY. No other fields editable.
// DELETE — rejected with 405 (periods are immutable structurally).
//
// Tangerine P1 Chunk 8b. Status transition matrix:
//   open       → soft_close | closed
//   soft_close → closed | open
//   closed     → soft_close | open
//   (same → same is accepted as no-op for idempotency)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const STATUS_VALUES = ["open", "soft_close", "closed"];

const VALID_TRANSITIONS = {
  open:       new Set(["open", "soft_close", "closed"]),
  soft_close: new Set(["soft_close", "open", "closed"]),
  closed:     new Set(["closed", "soft_close", "open"]),
};

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("gl_periods")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Period not found" });

    const { count, error: cErr } = await admin
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("period_id", id)
      .eq("status", "posted");
    if (cErr) return res.status(500).json({ error: cErr.message });
    return res.status(200).json({ ...data, posted_je_count: count ?? 0 });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    // Only status is patchable; reject every other field.
    const allowed = ["status"];
    for (const f of Object.keys(body || {})) {
      if (!allowed.includes(f)) {
        return res.status(400).json({ error: `${f} is not patchable. Only status is mutable.` });
      }
    }
    if (!body.status) return res.status(400).json({ error: "status is required" });
    if (!STATUS_VALUES.includes(body.status)) {
      return res.status(400).json({ error: `status must be one of ${STATUS_VALUES.join(", ")}` });
    }

    const { data: current, error: getErr } = await admin
      .from("gl_periods")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!current) return res.status(404).json({ error: "Period not found" });

    const transition = validateStatusTransition(current.status, body.status);
    if (transition.error) return res.status(400).json({ error: transition.error });

    // Build update payload that also adjusts soft_closed_at / closed_at.
    const now = new Date().toISOString();
    const update = { status: body.status };
    if (body.status === "soft_close") {
      update.soft_closed_at = now;
      update.closed_at = null;
    } else if (body.status === "closed") {
      if (current.status === "open") update.soft_closed_at = now;
      update.closed_at = now;
    } else if (body.status === "open") {
      update.soft_closed_at = null;
      update.closed_at = null;
      update.closed_by_user_id = null;
    }

    const { data, error } = await admin
      .from("gl_periods")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Periods are immutable; deletion is not supported." });
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}

/**
 * Validate that a status transition is allowed.
 * @returns {{ ok: true } | { error: string }}
 */
export function validateStatusTransition(currentStatus, nextStatus) {
  if (!STATUS_VALUES.includes(currentStatus)) {
    return { error: `Unknown current status: ${currentStatus}` };
  }
  if (!STATUS_VALUES.includes(nextStatus)) {
    return { error: `Unknown next status: ${nextStatus}` };
  }
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed.has(nextStatus)) {
    return { error: `Cannot transition from ${currentStatus} to ${nextStatus}` };
  }
  return { ok: true };
}
