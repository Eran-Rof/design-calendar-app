// api/internal/entities
//
// GET  — list all entities as a tree (children nested under parent).
//        Query: ?flat=true to return a flat list instead.
// POST — create a new entity. body: { name, slug, parent_entity_id? }.
//        Slug is lowercased and restricted to [a-z0-9-].

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function normalizeSlug(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

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
    const flat = url.searchParams.get("flat") === "true";

    const { data: entities, error } = await admin
      .from("entities")
      .select("*, branding:entity_branding(company_display_name, logo_url, primary_color, custom_domain)")
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    if (flat) return res.status(200).json(entities || []);

    // Build tree — children grouped under parent
    const byId = new Map((entities || []).map((e) => [e.id, { ...e, children: [] }]));
    const roots = [];
    for (const e of byId.values()) {
      if (e.parent_entity_id && byId.has(e.parent_entity_id)) {
        byId.get(e.parent_entity_id).children.push(e);
      } else {
        roots.push(e);
      }
    }
    return res.status(200).json(roots);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { name, slug, parent_entity_id } = body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
    const normSlug = normalizeSlug(slug || name);
    if (!normSlug) return res.status(400).json({ error: "Valid slug required (alphanumeric + dashes)" });

    if (parent_entity_id) {
      const { data: parent } = await admin.from("entities").select("id").eq("id", parent_entity_id).maybeSingle();
      if (!parent) return res.status(400).json({ error: "parent_entity_id not found" });
    }

    const { data, error } = await admin.from("entities").insert({
      name: String(name).trim(),
      slug: normSlug,
      parent_entity_id: parent_entity_id || null,
      status: "active",
    }).select("*").single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: `Slug '${normSlug}' is already taken` });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
