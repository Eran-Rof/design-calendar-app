// api/internal/ai/documents
//
// CRUD + render for ip_ai_documents (Tier 3J — saved Ask AI workflows).
//
// GET    ?user_id=&workflow=&q=                  list documents
// POST   { name, description?, workflow_name, params?, scope, user_id }   create
// PATCH  ?id=...   { ...updatable fields }                                update
// DELETE ?id=...                                                          delete
// POST   ?id=...&action=render                                            re-run workflow
//
// Auth: bearer token via authenticateInternalCaller. Internal staff only.
// Same shape as user-facts.js — one handler dispatching on method + action.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { WORKFLOWS, tool_start_workflow } from "../../../_lib/ai/workflows.js";

export const config = { maxDuration: 30 };  // render path may run 4-8 queries

const MAX_NAME_LEN  = 120;
const MAX_DESC_LEN  = 600;
const MAX_USER_LEN  = 80;

function clean(s, max) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  return t.slice(0, max);
}

const WORKFLOW_NAMES = new Set(WORKFLOWS.map(w => w.name));

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL      = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });

  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // POST + ?action=render is the render path. All other method calls dispatch by method.
  const action = (req.query?.action || "").toString();
  if (req.method === "POST" && action === "render") return doRender(req, res, db);

  if (req.method === "GET")    return doList(req, res, db);
  if (req.method === "POST")   return doCreate(req, res, db);
  if (req.method === "PATCH")  return doUpdate(req, res, db);
  if (req.method === "DELETE") return doDelete(req, res, db);
  return res.status(405).json({ error: "Method not allowed" });
}

async function doList(req, res, db) {
  const userId = clean(req.query?.user_id, MAX_USER_LEN);
  const workflow = clean(req.query?.workflow, 60);
  const q = clean(req.query?.q, 120);

  let query = db
    .from("ip_ai_documents")
    .select("id, user_id, name, description, workflow_name, params, created_by, created_at, updated_at, last_rendered_at")
    .order("updated_at", { ascending: false })
    .limit(200);

  if (userId) {
    query = query.or(`user_id.eq.${userId},user_id.is.null`);
  }
  if (workflow) {
    query = query.eq("workflow_name", workflow);
  }
  if (q) {
    const needle = `%${q.replace(/[%_]/g, "\\$&")}%`;
    query = query.or(`name.ilike.${needle},description.ilike.${needle}`);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ documents: data || [] });
}

async function doCreate(req, res, db) {
  const body = req.body || {};
  const name = clean(body.name, MAX_NAME_LEN);
  const workflowName = clean(body.workflow_name, 60);
  if (!name) return res.status(400).json({ error: "name required" });
  if (!workflowName) return res.status(400).json({ error: "workflow_name required" });
  if (!WORKFLOW_NAMES.has(workflowName)) {
    return res.status(400).json({ error: `Unknown workflow '${workflowName}'. Available: ${[...WORKFLOW_NAMES].join(", ")}.` });
  }

  const scope = body.scope === "shared" ? "shared" : "self";
  const requesterId = clean(body.user_id, MAX_USER_LEN);
  if (scope === "self" && !requesterId) {
    return res.status(400).json({ error: "user_id required for scope=self" });
  }

  const row = {
    user_id:       scope === "shared" ? null : requesterId,
    name,
    description:   clean(body.description, MAX_DESC_LEN),
    workflow_name: workflowName,
    params:        body.params && typeof body.params === "object" ? body.params : {},
    created_by:    requesterId,
  };
  const { data, error } = await db.from("ip_ai_documents").insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ document: data });
}

async function doUpdate(req, res, db) {
  const id = clean(req.query?.id, 64);
  if (!id) return res.status(400).json({ error: "id required" });
  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) {
    const v = clean(body.name, MAX_NAME_LEN);
    if (!v) return res.status(400).json({ error: "name cannot be empty" });
    patch.name = v;
  }
  if (body.description !== undefined) patch.description = clean(body.description, MAX_DESC_LEN);
  if (body.workflow_name !== undefined) {
    const v = clean(body.workflow_name, 60);
    if (!v || !WORKFLOW_NAMES.has(v)) return res.status(400).json({ error: "invalid workflow_name" });
    patch.workflow_name = v;
  }
  if (body.params !== undefined) {
    patch.params = body.params && typeof body.params === "object" ? body.params : {};
  }
  if (body.scope !== undefined) {
    if (body.scope === "shared") patch.user_id = null;
    else if (body.scope === "self") {
      const requesterId = clean(body.user_id, MAX_USER_LEN);
      if (!requesterId) return res.status(400).json({ error: "user_id required for scope=self" });
      patch.user_id = requesterId;
    }
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "no fields to update" });
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db.from("ip_ai_documents").update(patch).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ document: data });
}

async function doDelete(req, res, db) {
  const id = clean(req.query?.id, 64);
  if (!id) return res.status(400).json({ error: "id required" });
  const { error } = await db.from("ip_ai_documents").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(204).end();
}

async function doRender(req, res, db) {
  const id = clean(req.query?.id, 64);
  if (!id) return res.status(400).json({ error: "id required" });

  const { data: doc, error } = await db
    .from("ip_ai_documents")
    .select("id, user_id, name, description, workflow_name, params")
    .eq("id", id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!doc) return res.status(404).json({ error: "document not found" });

  // Run the workflow against live data. tool_start_workflow returns a
  // structured error on failure rather than throwing — preserve that
  // shape so the UI can show it inline instead of crashing.
  const rendered = await tool_start_workflow(db, {
    workflow_name: doc.workflow_name,
    params: doc.params || {},
  });

  // Best-effort bookkeeping; don't block the response if it fails.
  db.from("ip_ai_documents")
    .update({ last_rendered_at: new Date().toISOString() })
    .eq("id", id)
    .then(() => { /* fire-and-forget */ })
    .catch(() => { /* ignore */ });

  return res.status(200).json({
    document: {
      id: doc.id,
      name: doc.name,
      description: doc.description,
      workflow_name: doc.workflow_name,
      params: doc.params,
    },
    rendered_at: new Date().toISOString(),
    payload: rendered,
  });
}
