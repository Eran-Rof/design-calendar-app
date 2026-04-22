// api/internal/workspaces
//
// GET  — list workspaces for an entity (with task + pin counts).
//   ?entity_id=<uuid>  required (or X-Entity-ID header)
//   ?status=active|archived  (default active)
// POST — create workspace.
//   body: { entity_id, vendor_id, name, description?, created_by? }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
    if (!entityId) return res.status(400).json({ error: "entity_id query or X-Entity-ID header required" });
    const status = url.searchParams.get("status") || "active";

    const { data: workspaces, error } = await admin
      .from("collaboration_workspaces")
      .select("*, vendor:vendors(id, name)")
      .eq("entity_id", entityId).eq("status", status)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const ids = (workspaces || []).map((w) => w.id);
    const counts = ids.length ? await countsByWorkspace(admin, ids) : {};
    const out = (workspaces || []).map((w) => ({
      ...w,
      task_count: counts[w.id]?.tasks || 0,
      open_task_count: counts[w.id]?.open_tasks || 0,
      pin_count: counts[w.id]?.pins || 0,
    }));
    return res.status(200).json({ rows: out });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { entity_id, vendor_id, name, description, created_by } = body || {};
    if (!entity_id || !vendor_id || !name || !String(name).trim()) {
      return res.status(400).json({ error: "entity_id, vendor_id, and name are required" });
    }

    const { data: created, error } = await admin
      .from("collaboration_workspaces")
      .insert({ entity_id, vendor_id, name: String(name).trim(), description: description || null, created_by: created_by || null })
      .select("*, vendor:vendors(id, name)").single();
    if (error) return res.status(500).json({ error: error.message });

    // Fire workspace_invited notification to the vendor's primary users
    try {
      const origin = `https://${req.headers.host}`;
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "workspace_invited",
          title: `You've been invited to a collaboration workspace: ${created.name}`,
          body: `You've been invited to collaborate in '${created.name}'.`,
          link: "/vendor/workspaces",
          metadata: { workspace_id: created.id, vendor_id },
          recipient: { vendor_id },
          dedupe_key: `workspace_invited_${created.id}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* non-blocking */ }

    return res.status(201).json(created);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function countsByWorkspace(admin, ids) {
  const [{ data: tasks }, { data: pins }] = await Promise.all([
    admin.from("workspace_tasks").select("workspace_id, status").in("workspace_id", ids),
    admin.from("workspace_pins").select("workspace_id").in("workspace_id", ids),
  ]);
  const out = {};
  for (const t of tasks || []) {
    const r = (out[t.workspace_id] ||= { tasks: 0, open_tasks: 0, pins: 0 });
    r.tasks += 1;
    if (t.status === "open" || t.status === "in_progress") r.open_tasks += 1;
  }
  for (const p of pins || []) {
    const r = (out[p.workspace_id] ||= { tasks: 0, open_tasks: 0, pins: 0 });
    r.pins += 1;
  }
  return out;
}
