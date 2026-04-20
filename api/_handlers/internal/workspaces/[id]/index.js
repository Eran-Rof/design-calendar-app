// api/internal/workspaces/:id
//
// GET — workspace detail: pins (resolved), tasks, recent messages.
// PUT — update workspace fields (name, description, status).

import { createClient } from "@supabase/supabase-js";
import { loadWorkspace, resolvePinsBatch } from "../../../../_lib/workspaces.js";

export const config = { maxDuration: 15 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("workspaces");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing workspace id" });

  if (req.method === "GET") {
    const w = await loadWorkspace(admin, id);
    if (!w) return res.status(404).json({ error: "Workspace not found" });
    const [{ data: rawPins }, { data: tasks }, { data: messages }] = await Promise.all([
      admin.from("workspace_pins").select("*").eq("workspace_id", id).order("created_at", { ascending: false }),
      admin.from("workspace_tasks").select("*").eq("workspace_id", id).order("created_at", { ascending: false }),
      admin.from("po_messages").select("*").eq("workspace_id", id).order("created_at", { ascending: true }),
    ]);
    const pins = await resolvePinsBatch(admin, rawPins || []);
    return res.status(200).json({ workspace: w, pins, tasks: tasks || [], messages: messages || [] });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const updates = {};
    if (body?.name !== undefined) updates.name = String(body.name).trim();
    if (body?.description !== undefined) updates.description = body.description || null;
    if (body?.status !== undefined) {
      if (!["active", "archived"].includes(body.status)) return res.status(400).json({ error: "status must be active|archived" });
      updates.status = body.status;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields" });
    updates.updated_at = new Date().toISOString();

    const { error } = await admin.from("collaboration_workspaces").update(updates).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, id, ...updates });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
