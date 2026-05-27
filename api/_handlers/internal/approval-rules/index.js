// api/internal/approval-rules
//
// GET  — list rules. Default returns active only; ?include_inactive=true for all.
//        Query: ?kind=<str>
// POST — create one rule. Validates match + steps JSONB via the lib schema.
//
// Tangerine P2 Chunk 2.

import { createClient } from "@supabase/supabase-js";
import { validateRule } from "../../../_lib/approvals/schema.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const kind = (url.searchParams.get("kind") || "").trim();

    let query = admin
      .from("approval_rules")
      .select("*")
      .eq("entity_id", entityId)
      .order("kind", { ascending: true })
      .order("name", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (kind) query = query.eq("kind", kind);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const { data, error } = await admin
      .from("approval_rules")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (!body.kind || !String(body.kind).trim()) {
    return { error: "kind is required" };
  }
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }
  const match = body.match == null ? {} : body.match;
  const steps = body.steps;
  const v = validateRule({ match, steps });
  if (!v.ok) return { error: v.error };

  return {
    data: {
      kind: String(body.kind).trim(),
      name: String(body.name).trim(),
      match,
      steps,
      is_active: body.is_active !== false,
    },
  };
}
