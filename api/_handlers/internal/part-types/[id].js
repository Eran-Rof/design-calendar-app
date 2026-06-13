// api/internal/part-types/[id]
//
// GET    — fetch one part_type_master row.
// PATCH  — update name, sort_order, is_active. `code` + `entity_id` are LOCKED
//          (code is stored on part_master.part_type).
// DELETE — hard-delete; blocked if any part still uses the type (deactivate instead).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUTABLE = new Set(["name", "sort_order", "is_active"]);
const LOCKED = new Set(["code", "entity_id", "id"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin.from("part_type_master").select("*").eq("id", id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Part type not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    for (const f of Object.keys(body)) {
      if (LOCKED.has(f)) return res.status(400).json({ error: `${f} is locked post-creation` });
    }
    const out = {};
    for (const [k, val] of Object.entries(body)) if (MUTABLE.has(k)) out[k] = val;
    if ("name" in out) { if (!String(out.name).trim()) return res.status(400).json({ error: "name cannot be empty" }); out.name = String(out.name).trim(); }
    if ("sort_order" in out) {
      const n = typeof out.sort_order === "number" ? out.sort_order : parseInt(out.sort_order, 10);
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: "sort_order must be a non-negative integer" });
      out.sort_order = n;
    }
    if ("is_active" in out && typeof out.is_active !== "boolean") out.is_active = out.is_active === "true" || out.is_active === 1;
    if (Object.keys(out).length === 0) return res.status(400).json({ error: "No mutable fields supplied" });
    out.updated_at = new Date().toISOString();
    const { data, error } = await admin.from("part_type_master").update(out).eq("id", id).select().single();
    if (error) { if (error.code === "PGRST116") return res.status(404).json({ error: "Part type not found" }); return res.status(500).json({ error: error.message }); }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data: row } = await admin.from("part_type_master").select("code, entity_id").eq("id", id).maybeSingle();
    if (!row) return res.status(404).json({ error: "Part type not found" });
    const { count } = await admin.from("part_master").select("id", { count: "exact", head: true })
      .eq("entity_id", row.entity_id).eq("part_type", row.code);
    if ((count || 0) > 0) return res.status(409).json({ error: `Cannot delete: ${count} part(s) use this type. Deactivate it instead.` });
    const { error } = await admin.from("part_type_master").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
