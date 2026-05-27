// api/internal/employees
//
// GET  — list employees. Default: active only; ?include_inactive=true.
//        Query: ?q=<search> over code/first/last/email; ?department=<str>
// POST — create one. code + email unique per entity.
//
// Tangerine P2 Chunk 8.

import { createClient } from "@supabase/supabase-js";

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
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
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
    const q = (url.searchParams.get("q") || "").trim();
    const dept = (url.searchParams.get("department") || "").trim();

    let query = admin
      .from("employees")
      .select("*")
      .eq("entity_id", entityId)
      .order("display_name", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (dept) query = query.eq("department", dept);
    if (q) {
      query = query.or(`code.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`);
    }

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
      .from("employees")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `Employee with that code or email already exists for this entity` });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (!body.code || !String(body.code).trim()) return { error: "code required" };
  if (!body.first_name || !String(body.first_name).trim()) return { error: "first_name required" };
  if (!body.last_name || !String(body.last_name).trim()) return { error: "last_name required" };
  if (!body.email || !String(body.email).trim()) return { error: "email required" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return { error: "email must be a valid address" };

  if (body.hire_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.hire_date)) {
    return { error: "hire_date must be YYYY-MM-DD" };
  }
  if (body.termination_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.termination_date)) {
    return { error: "termination_date must be YYYY-MM-DD" };
  }
  if (body.hire_date && body.termination_date && body.termination_date < body.hire_date) {
    return { error: "termination_date cannot precede hire_date" };
  }
  if (body.auth_user_id && !/^[0-9a-f-]{36}$/i.test(body.auth_user_id)) {
    return { error: "auth_user_id (when set) must be uuid" };
  }
  if (body.manager_employee_id && !/^[0-9a-f-]{36}$/i.test(body.manager_employee_id)) {
    return { error: "manager_employee_id (when set) must be uuid" };
  }

  return {
    data: {
      code: String(body.code).trim().toUpperCase(),
      first_name: String(body.first_name).trim(),
      last_name: String(body.last_name).trim(),
      email: String(body.email).trim().toLowerCase(),
      title: body.title ? String(body.title).trim() : null,
      department: body.department ? String(body.department).trim() : null,
      hire_date: body.hire_date || null,
      termination_date: body.termination_date || null,
      is_active: body.is_active !== false,
      phone: body.phone ? String(body.phone).trim() : null,
      auth_user_id: body.auth_user_id || null,
      manager_employee_id: body.manager_employee_id || null,
      metadata: body.metadata || {},
    },
  };
}
