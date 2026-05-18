// api/internal/ai/user-facts
//
// CRUD for ip_ai_user_facts (Tier 2H — operator-authored Ask AI notes).
//
// GET    ?user_id=&app=&q=    list facts (filtered)
// POST   { topic, fact, scope: "self" | "global", app?, user_id }   create
// PATCH  ?id=...   { topic, fact, scope, app }                       update
// DELETE ?id=...                                                     delete
//
// Auth: bearer token via authenticateInternalCaller. Internal staff
// only — no vendor exposure.
//
// Why one handler for all four verbs: keeps the route table from
// exploding, matches the existing pattern (api/_handlers/internal/*/index.js
// often dispatch on method). Each branch is small.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 10 };

const MAX_TOPIC_LEN = 80;
const MAX_FACT_LEN  = 4000;   // generous — only trimmed at read-time for the AI
const MAX_APP_LEN   = 40;
const MAX_USER_LEN  = 80;

function clean(s, max) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  return t.slice(0, max);
}

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

  if (req.method === "GET")    return doList(req, res, db);
  if (req.method === "POST")   return doCreate(req, res, db);
  if (req.method === "PATCH")  return doUpdate(req, res, db);
  if (req.method === "DELETE") return doDelete(req, res, db);
  return res.status(405).json({ error: "Method not allowed" });
}

async function doList(req, res, db) {
  const userId = clean(req.query?.user_id, MAX_USER_LEN);
  const app    = clean(req.query?.app,     MAX_APP_LEN);
  const q      = clean(req.query?.q,       80);

  let query = db
    .from("ip_ai_user_facts")
    .select("id, user_id, app, topic, fact, created_by, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(200);

  // Scope: when user_id supplied, return their own facts + globals
  // (user_id IS NULL). Without user_id, return everything (admin view).
  if (userId) {
    query = query.or(`user_id.eq.${userId},user_id.is.null`);
  }
  if (app) {
    query = query.or(`app.eq.${app},app.is.null`);
  }
  if (q) {
    const needle = `%${q.replace(/[%_]/g, "\\$&")}%`;
    query = query.or(`topic.ilike.${needle},fact.ilike.${needle}`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ facts: data || [] });
}

async function doCreate(req, res, db) {
  const body = req.body || {};
  const topic = clean(body.topic, MAX_TOPIC_LEN);
  const fact  = clean(body.fact,  MAX_FACT_LEN);
  if (!topic) return res.status(400).json({ error: "topic required" });
  if (!fact)  return res.status(400).json({ error: "fact required" });

  // scope: "self" → user_id = the operator; "global" → user_id = null
  // (visible to every operator). Default is "self" to avoid accidental
  // global broadcasts.
  const scope = body.scope === "global" ? "global" : "self";
  const requesterId = clean(body.user_id, MAX_USER_LEN);
  if (scope === "self" && !requesterId) {
    return res.status(400).json({ error: "user_id required for scope=self" });
  }
  const row = {
    user_id:    scope === "global" ? null : requesterId,
    app:        clean(body.app, MAX_APP_LEN),
    topic,
    fact,
    created_by: requesterId,
  };
  const { data, error } = await db
    .from("ip_ai_user_facts")
    .insert(row)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ fact: data });
}

async function doUpdate(req, res, db) {
  const id = clean(req.query?.id, 64);
  if (!id) return res.status(400).json({ error: "id required" });
  const body = req.body || {};
  const patch = {};
  if (body.topic !== undefined) {
    const t = clean(body.topic, MAX_TOPIC_LEN);
    if (!t) return res.status(400).json({ error: "topic cannot be empty" });
    patch.topic = t;
  }
  if (body.fact !== undefined) {
    const f = clean(body.fact, MAX_FACT_LEN);
    if (!f) return res.status(400).json({ error: "fact cannot be empty" });
    patch.fact = f;
  }
  if (body.scope !== undefined) {
    if (body.scope === "global") patch.user_id = null;
    else if (body.scope === "self") {
      const requesterId = clean(body.user_id, MAX_USER_LEN);
      if (!requesterId) return res.status(400).json({ error: "user_id required for scope=self" });
      patch.user_id = requesterId;
    }
  }
  if (body.app !== undefined) {
    patch.app = clean(body.app, MAX_APP_LEN);
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "no fields to update" });
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("ip_ai_user_facts")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ fact: data });
}

async function doDelete(req, res, db) {
  const id = clean(req.query?.id, 64);
  if (!id) return res.status(400).json({ error: "id required" });
  const { error } = await db.from("ip_ai_user_facts").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(204).end();
}
