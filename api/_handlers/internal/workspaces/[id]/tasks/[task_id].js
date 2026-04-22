// api/internal/workspaces/:id/tasks/:task_id
//
// PUT — update task (status, title, description, due_date, assignment).

import { createClient } from "@supabase/supabase-js";
import { validateTaskInput } from "../../../../../_lib/workspaces.js";

export const config = { maxDuration: 10 };

function getIds(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const wsIdx = parts.indexOf("workspaces");
  const tasksIdx = parts.lastIndexOf("tasks");
  return {
    workspaceId: wsIdx >= 0 ? parts[wsIdx + 1] : null,
    taskId:      tasksIdx > 0 && tasksIdx + 1 < parts.length ? parts[tasksIdx + 1] : null,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { workspaceId, taskId } = getIds(req);
  if (!workspaceId || !taskId) return res.status(400).json({ error: "Missing workspace or task id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const errs = validateTaskInput(body, { partial: true });
  if (errs.length) return res.status(400).json({ error: errs.join("; ") });

  const updates = {};
  for (const k of ["title", "description", "status", "assigned_to_type", "assigned_to", "due_date"]) {
    if (body[k] !== undefined) updates[k] = body[k];
  }
  if (body.status === "complete") updates.completed_at = new Date().toISOString();
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields" });
  updates.updated_at = new Date().toISOString();

  const { error } = await admin.from("workspace_tasks").update(updates)
    .eq("id", taskId).eq("workspace_id", workspaceId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id: taskId, ...updates });
}
