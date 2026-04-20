// api/vendor/workspaces/:id/tasks
//
// GET  — list tasks for the vendor's workspace.
// POST — vendor-created task.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../../_lib/vendor-auth.js";
import { authorizeVendorAccess, validateTaskInput } from "../../../../../_lib/workspaces.js";

export const config = { maxDuration: 10 };

function getWorkspaceId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("tasks");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });

  const workspaceId = getWorkspaceId(req);
  const w = await authorizeVendorAccess(admin, workspaceId, authRes.auth.vendor_id);
  if (!w) return res.status(404).json({ error: "Workspace not found" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("workspace_tasks").select("*")
      .eq("workspace_id", workspaceId).order("created_at", { ascending: false });
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
      created_by_type: "vendor",
      created_by: authRes.auth.vendor_user_id || authRes.auth.vendor_id,
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });

    if (data.assigned_to_type === "vendor") {
      try {
        const origin = `https://${req.headers.host}`;
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "workspace_task_assigned",
            title: `New task assigned: ${data.title}`,
            body: data.description || `A new task has been assigned${data.due_date ? ` (due ${data.due_date})` : ""}.`,
            link: "/vendor/workspaces",
            metadata: { task_id: data.id, workspace_id: workspaceId },
            recipient: { vendor_id: authRes.auth.vendor_id },
            dedupe_key: `workspace_task_assigned_${data.id}`,
            email: true, push: true,
          }),
        }).catch(() => {});
      } catch { /* non-blocking */ }
    }

    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
