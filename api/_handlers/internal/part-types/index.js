// api/internal/part-types
//
// GET  — list part types. is_active=true only by default; ?include_inactive=true.
//        ?q=<search> ilike-matches code/name.
// POST — create a part_type_master row. Body: { code (required, lowercased),
//        name (required), sort_order?, is_active? }. `code` is operator-supplied
//        and locked after creation (it is the value stored on part_master.part_type).
//
// Tangerine — Manufacturing Part Type Master (drives the Part Master type dropdown).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id ?? null;
}
// Normalize an operator code to a stable kebab/snake token.
function normalizeCode(raw) {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
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
    const q = (url.searchParams.get("q") || "").trim();
    let query = admin.from("part_type_master").select("*").eq("entity_id", entityId)
      .order("sort_order", { ascending: true }).order("name", { ascending: true });
    if (!includeInactive) query = query.eq("is_active", true);
    if (q) { const esc = q.replace(/[,()]/g, " "); query = query.or(`code.ilike.%${esc}%,name.ilike.%${esc}%`); }
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const { data, error } = await admin.from("part_type_master")
      .insert({ ...v.data, entity_id: entityId }).select().single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: `A part type with code '${v.data.code}' already exists.` });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") return { error: "Request body must be an object" };
  if (!body.name || !String(body.name).trim()) return { error: "name is required" };
  if (!body.code || !normalizeCode(body.code)) return { error: "code is required (letters/numbers)" };
  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) return { error: "sort_order must be a non-negative integer" };
  }
  const isActive = body.is_active == null ? true : typeof body.is_active === "boolean" ? body.is_active : body.is_active === "true" || body.is_active === 1;
  return { data: { code: normalizeCode(body.code), name: String(body.name).trim(), sort_order: sortOrder, is_active: isActive } };
}
