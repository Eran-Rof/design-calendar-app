// api/internal/tpl-providers  (h617)
//
// P21 / M13 — 3PL provider master.
//
//   GET   /api/internal/tpl-providers                → list (+ linked location)
//   POST  /api/internal/tpl-providers                → create
//   PATCH /api/internal/tpl-providers                → edit (body.id required)
//        body { name, kind?, location_id?, contact_name?, email?, phone?,
//               account_ref?, billing_notes?, is_active?, notes? }
//        `code` is AUTO-GENERATED (TPL-NNNNN) by a DB trigger and is immutable —
//        not accepted on create, frozen on update.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
// `code` is intentionally omitted — auto-generated (TPL-NNNNN) + immutable (DB trigger).
const FIELDS = ["name","kind","location_id","contact_name","email","phone","account_ref","billing_notes","is_active","notes","edi_protocol","edi_endpoint","edi_username","edi_credential_ref","inventory_sftp_path"];
// Up to 8 contacts, each {name,title,department,email,phone} (strings only). Blank
// rows dropped; truncated to 8. Mirrors customer-master sanitizeContacts.
function sanitizeContacts(raw) {
  if (!Array.isArray(raw)) return [];
  const keys = ["name", "title", "department", "email", "phone"];
  const out = [];
  for (const c of raw) {
    if (c == null || typeof c !== "object") continue;
    const row = {};
    for (const k of keys) { const v = c[k]; if (v != null && String(v).trim() !== "") row[k] = String(v).trim(); }
    if (typeof c.id === "string" && c.id) row.id = c.id;
    if (Object.keys(row).length) out.push(row);
    if (out.length >= 8) break;
  }
  return out;
}
function pick(body) {
  const o = {};
  for (const f of FIELDS) if (body[f] !== undefined) o[f] = body[f] === "" ? null : body[f];
  if (body.contacts !== undefined) o.contacts = sanitizeContacts(body.contacts);
  return o;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("tpl_providers")
      .select("*, inventory_locations(code, name, kind)")
      .order("name", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ providers: data || [] });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};

  if (req.method === "POST") {
    if (!body.name) return res.status(400).json({ error: "name required" });
    const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
    const row = { entity_id: entity.id, ...pick(body), created_by_user_id: body.created_by_user_id || null };
    const { data, error } = await admin.from("tpl_providers").insert(row).select("id").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id: data.id, message: "3PL provider created." });
  }

  if (req.method === "PATCH") {
    if (!body.id) return res.status(400).json({ error: "id required" });
    const patch = { ...pick(body), updated_at: new Date().toISOString() };
    const { error } = await admin.from("tpl_providers").update(patch).eq("id", body.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
