// api/internal/employees/[id]
//
// GET    — fetch one employee.
// PATCH  — update mutable fields. code + entity_id locked post-creation.
// DELETE — soft-delete via is_active=false; we do not hard-delete because
//          manager_employee_id self-FKs and audit trails reference rows.
//          Use PATCH { is_active: false } via this endpoint as a 204 sugar.
//
// Tangerine P2 Chunk 8.

import { createClient } from "@supabase/supabase-js";

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

  const id = params?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("employees")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Employee not found" });
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
      .from("employees")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Employee not found" });
      if (error.code === "23505") return res.status(409).json({ error: "Email already used by another employee in this entity" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Soft delete only - flip is_active=false
    const { data, error } = await admin
      .from("employees")
      .update({ is_active: false })
      .eq("id", id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Employee not found" });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

// Strict UUID format: 8-4-4-4-12 hex chars with dashes at exact positions.
// Permissive enough for any standard v1/v4 UUID, strict enough that the DB
// won't reject with 22P02.
function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function validatePatch(body) {
  const data = {};

  if ("code" in body) return { error: "code is locked post-creation" };
  if ("entity_id" in body) return { error: "entity_id is locked" };

  if ("first_name" in body) {
    if (!body.first_name || !String(body.first_name).trim()) return { error: "first_name must be non-empty" };
    data.first_name = String(body.first_name).trim();
  }
  if ("last_name" in body) {
    if (!body.last_name || !String(body.last_name).trim()) return { error: "last_name must be non-empty" };
    data.last_name = String(body.last_name).trim();
  }
  if ("email" in body) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email || "")) return { error: "email must be a valid address" };
    data.email = String(body.email).trim().toLowerCase();
  }
  if ("title" in body) data.title = body.title ? String(body.title).trim() : null;
  if ("department" in body) data.department = body.department ? String(body.department).trim() : null;
  if ("hire_date" in body) {
    if (body.hire_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.hire_date)) return { error: "hire_date must be YYYY-MM-DD" };
    data.hire_date = body.hire_date || null;
  }
  if ("termination_date" in body) {
    if (body.termination_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.termination_date)) return { error: "termination_date must be YYYY-MM-DD" };
    data.termination_date = body.termination_date || null;
  }
  if ("is_active" in body) {
    if (typeof body.is_active !== "boolean") return { error: "is_active must be a boolean" };
    data.is_active = body.is_active;
  }
  if ("phone" in body) data.phone = body.phone ? String(body.phone).trim() : null;
  if ("auth_user_id" in body) {
    const v = body.auth_user_id;
    const trimmed = typeof v === "string" ? v.trim() : v;
    if (trimmed && !isUuid(trimmed)) {
      return { error: `auth_user_id must be a uuid (got: ${JSON.stringify(v)})` };
    }
    data.auth_user_id = trimmed || null;
  }
  if ("manager_employee_id" in body) {
    const v = body.manager_employee_id;
    const trimmed = typeof v === "string" ? v.trim() : v;
    if (trimmed && !isUuid(trimmed)) {
      return { error: `manager_employee_id must be a uuid (got: ${JSON.stringify(v)})` };
    }
    data.manager_employee_id = trimmed || null;
  }
  if ("metadata" in body) data.metadata = body.metadata || {};

  return { data };
}
