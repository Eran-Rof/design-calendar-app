// api/internal/crm/tasks/:id
//
// GET    — fetch one task.
// PATCH  — update (title, description, due_date, status, priority,
//          assignee_user_id, customer_id, opportunity_id).
//          When status flips to 'done', the P8-1 BEFORE-UPDATE trigger
//          auto-populates completed_at + completed_by_user_id (using the
//          GUC app.current_user_id, optionally set here via actor_user_id)
//          and logs a task_done activity.
// DELETE — hard-delete.
//
// Tangerine P8-2 (arch §4).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_VALUES = ["open", "in_progress", "done", "cancelled"];
const PRIORITY_VALUES = ["low", "normal", "high", "urgent"];

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

  const { data: taskRow, error: fetchErr } = await admin
    .from("crm_tasks")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!taskRow) return res.status(404).json({ error: "Task not found" });

  if (req.method === "GET") {
    return res.status(200).json(taskRow);
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
      return res.status(200).json(taskRow);
    }

    // Set session actor so completion trigger picks up completed_by_user_id.
    if (body && body.actor_user_id && UUID_RE.test(String(body.actor_user_id))) {
      await admin.rpc("set_config", {
        setting_name: "app.current_user_id",
        new_value: String(body.actor_user_id),
        is_local: true,
      }).catch(() => {});
    }

    const { data: updated, error: upErr } = await admin
      .from("crm_tasks")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    const { error: delErr } = await admin.from("crm_tasks").delete().eq("id", id);
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
    "id", "entity_id",
    "completed_at", "completed_by_user_id",
    "created_at", "updated_at", "created_by_user_id",
  ];
  for (const k of LOCKED) {
    if (k in body) return { error: `${k} is not patchable here` };
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
  if ("status" in body) {
    if (!STATUS_VALUES.includes(body.status)) {
      return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
    }
    out.status = body.status;
  }
  if ("priority" in body) {
    if (!PRIORITY_VALUES.includes(body.priority)) {
      return { error: `priority must be one of ${PRIORITY_VALUES.join(", ")}` };
    }
    out.priority = body.priority;
  }
  if ("due_date" in body) {
    if (body.due_date == null || body.due_date === "") {
      out.due_date = null;
    } else {
      const d = String(body.due_date).trim();
      if (!DATE_RE.test(d)) return { error: "due_date must be YYYY-MM-DD" };
      out.due_date = d;
    }
  }
  if ("assignee_user_id" in body) {
    if (body.assignee_user_id == null || body.assignee_user_id === "") {
      out.assignee_user_id = null;
    } else if (!UUID_RE.test(body.assignee_user_id)) {
      return { error: "assignee_user_id must be a uuid or null" };
    } else {
      out.assignee_user_id = body.assignee_user_id;
    }
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
  if ("opportunity_id" in body) {
    if (body.opportunity_id == null || body.opportunity_id === "") {
      out.opportunity_id = null;
    } else if (!UUID_RE.test(body.opportunity_id)) {
      return { error: "opportunity_id must be a uuid or null" };
    } else {
      out.opportunity_id = body.opportunity_id;
    }
  }

  return { data: out };
}
