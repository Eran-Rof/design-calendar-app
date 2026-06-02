// api/internal/approval-rules/[id]
//
// GET    — fetch a single rule.
// PATCH  — update name/match/steps/is_active. kind is LOCKED post-creation.
// DELETE — hard-delete. Existing approval_requests are not cascade-affected
//          because they snapshot a copy of the matched payload at request
//          creation time. A rule's deletion only prevents future matches.
//
// Tangerine P2 Chunk 2.

import { createClient } from "@supabase/supabase-js";
import { validateMatch, validateSteps } from "../../../_lib/approvals/schema.js";

export const config = { maxDuration: 15 };

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

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id || req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("approval_rules")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Rule not found" });
    return res.status(200).json(data);
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
      return res.status(400).json({ error: "No mutable fields supplied" });
    }
    const { data, error } = await admin
      .from("approval_rules")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Rule not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { error } = await admin
      .from("approval_rules")
      .delete()
      .eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  const data = {};

  if ("name" in body) {
    if (!body.name || !String(body.name).trim()) return { error: "name must be non-empty" };
    data.name = String(body.name).trim();
  }
  if ("match" in body) {
    const m = validateMatch(body.match);
    if (!m.ok) return { error: m.error };
    data.match = body.match;
  }
  if ("steps" in body) {
    const s = validateSteps(body.steps);
    if (!s.ok) return { error: s.error };
    data.steps = body.steps;
  }
  if ("is_active" in body) {
    if (typeof body.is_active !== "boolean") return { error: "is_active must be a boolean" };
    data.is_active = body.is_active;
  }
  if ("kind" in body) {
    return { error: "kind is locked post-creation" };
  }
  if ("entity_id" in body) {
    return { error: "entity_id is locked" };
  }

  return { data };
}
