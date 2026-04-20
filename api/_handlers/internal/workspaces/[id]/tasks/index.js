// api/internal/workspaces/:id/tasks
//
// GET  — list tasks for workspace.
// POST — create task.
//   body: { title, description?, assigned_to_type?, assigned_to?, due_date?, created_by? }

import { createClient } from "@supabase/supabase-js";
import { validateTaskInput } from "../../../../../_lib/workspaces.js";

export const config = { maxDuration: 10 };

function getWorkspaceId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("tasks");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const workspaceId = getWorkspaceId(req);
  if (!workspaceId) return res.status(400).json({ error: "Missing workspace id" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("workspace_tasks").select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const errs = validateTaskInput(body);
    if (errs.length) return res.status(400).json({ error: errs.join("; ") });

    const { data, error } = await admin.from("workspace_tasks").insert({
      workspace_id: workspaceId,
      title: String(body.title).trim(),
      description: body.description || null,
      assigned_to_type: body.assigned_to_type || null,
      assigned_to: body.assigned_to || null,
      due_date: body.due_date || null,
      created_by_type: "internal",
      created_by: body.created_by || null,
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });

    // workspace_task_assigned — only when the assignee is a vendor
    if (data.assigned_to_type === "vendor") {
      try {
        const { data: ws } = await admin.from("collaboration_workspaces")
          .select("vendor_id").eq("id", workspaceId).maybeSingle();
        if (ws?.vendor_id) {
          const origin = `https://${req.headers.host}`;
          await fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "workspace_task_assigned",
              title: `New task assigned: ${data.title}`,
              body: data.description || `A new task has been assigned to you${data.due_date ? ` (due ${data.due_date})` : ""}.`,
              link: "/vendor/workspaces",
              metadata: { task_id: data.id, workspace_id: workspaceId },
              recipient: { vendor_id: ws.vendor_id },
              dedupe_key: `workspace_task_assigned_${data.id}`,
              email: true, push: true,
            }),
          }).catch(() => {});
        }
      } catch { /* non-blocking */ }
    }

    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
