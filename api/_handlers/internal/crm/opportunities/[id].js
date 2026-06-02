// api/internal/crm/opportunities/:id
//
// GET    — fetch one opportunity + customer + recent activities + open tasks.
// PATCH  — update header (NOT stage — must use /:id/stage endpoint).
//          Editable: title, customer_id, owner_user_id, expected_cents,
//          probability_pct, expected_close_date, actual_close_date,
//          description, metadata, loss_reason.
// DELETE — hard-delete. Activities/tasks lose their FK pointer (ON DELETE
//          SET NULL) but are preserved for audit.
//
// Tangerine P8-2 (arch §4).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
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

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: oppRow, error: fetchErr } = await admin
    .from("crm_opportunities")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!oppRow) return res.status(404).json({ error: "Opportunity not found" });

  if (req.method === "GET") {
    let customer = null;
    if (oppRow.customer_id) {
      const { data: c } = await admin
        .from("customers")
        .select("id, code, name")
        .eq("id", oppRow.customer_id)
        .maybeSingle();
      customer = c || null;
    }

    const { data: activities } = await admin
      .from("crm_activities")
      .select("id, activity_type, subject, body, occurred_at, duration_minutes, external_email, payload, is_hidden, created_at, created_by_user_id")
      .eq("opportunity_id", id)
      .order("occurred_at", { ascending: false })
      .limit(50);

    const { data: openTasks } = await admin
      .from("crm_tasks")
      .select("id, title, status, priority, due_date, assignee_user_id, created_at")
      .eq("opportunity_id", id)
      .in("status", ["open", "in_progress"])
      .order("due_date", { ascending: true, nullsFirst: false });

    return res.status(200).json({
      ...oppRow,
      customer,
      activities: activities || [],
      open_tasks: openTasks || [],
    });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    if (Object.keys(v.data).length === 0) {
      return res.status(200).json(oppRow);
    }

    // Set session actor so any future audit trigger picks it up.
    if (body && body.actor_user_id && UUID_RE.test(String(body.actor_user_id))) {
      await admin.rpc("set_config", {
        setting_name: "app.current_user_id",
        new_value: String(body.actor_user_id),
        is_local: true,
      }).catch(() => {});
    }

    const { data: updated, error: upErr } = await admin
      .from("crm_opportunities")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    const { error: delErr } = await admin.from("crm_opportunities").delete().eq("id", id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function validatePatch(body) {
  // Server-controlled / locked columns.
  const LOCKED = [
    "id", "entity_id", "opportunity_number",
    "stage", "stage_changed_at",  // stage must go through /:id/stage RPC
    "created_at", "updated_at", "created_by_user_id",
  ];
  for (const k of LOCKED) {
    if (k in body) {
      if (k === "stage") {
        return { error: "stage is not patchable here; use POST /api/internal/crm/opportunities/:id/stage" };
      }
      return { error: `${k} is not patchable here` };
    }
  }

  const out = {};

  if ("title" in body) {
    const s = typeof body.title === "string" ? body.title.trim() : "";
    if (!s) return { error: "title must be non-empty" };
    if (s.length > 500) return { error: "title must be ≤ 500 chars" };
    out.title = s;
  }
  if ("description" in body) {
    out.description = body.description == null ? null : String(body.description);
  }
  if ("loss_reason" in body) {
    out.loss_reason = body.loss_reason == null ? null : String(body.loss_reason);
  }

  if ("customer_id" in body) {
    if (body.customer_id == null || body.customer_id === "") {
      out.customer_id = null;
    } else if (!UUID_RE.test(body.customer_id)) {
      return { error: "customer_id must be a uuid or null" };
    } else {
      out.customer_id = body.customer_id;
    }
  }
  if ("owner_user_id" in body) {
    if (body.owner_user_id == null || body.owner_user_id === "") {
      out.owner_user_id = null;
    } else if (!UUID_RE.test(body.owner_user_id)) {
      return { error: "owner_user_id must be a uuid or null" };
    } else {
      out.owner_user_id = body.owner_user_id;
    }
  }

  if ("expected_cents" in body) {
    if (body.expected_cents == null || body.expected_cents === "") {
      out.expected_cents = null;
    } else {
      const n = Number(body.expected_cents);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return { error: "expected_cents must be a non-negative integer" };
      }
      out.expected_cents = n;
    }
  }
  if ("probability_pct" in body) {
    const n = Number(body.probability_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100 || !Number.isInteger(n)) {
      return { error: "probability_pct must be an integer between 0 and 100" };
    }
    out.probability_pct = n;
  }
  if ("expected_close_date" in body) {
    if (body.expected_close_date == null || body.expected_close_date === "") {
      out.expected_close_date = null;
    } else {
      const d = String(body.expected_close_date).trim();
      if (!DATE_RE.test(d)) return { error: "expected_close_date must be YYYY-MM-DD" };
      out.expected_close_date = d;
    }
  }
  if ("actual_close_date" in body) {
    if (body.actual_close_date == null || body.actual_close_date === "") {
      out.actual_close_date = null;
    } else {
      const d = String(body.actual_close_date).trim();
      if (!DATE_RE.test(d)) return { error: "actual_close_date must be YYYY-MM-DD" };
      out.actual_close_date = d;
    }
  }
  if ("metadata" in body) {
    if (body.metadata == null) {
      out.metadata = {};
    } else if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      return { error: "metadata must be an object" };
    } else {
      out.metadata = body.metadata;
    }
  }

  return { data: out };
}
