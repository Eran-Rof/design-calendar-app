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

// Strict UUID format: 8-4-4-4-12 hex chars with dashes at exact positions.
// The loose `[0-9a-f-]{36}` regex used previously accepted strings the
// Postgres uuid type then rejected with 22P02 invalid input syntax.
function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
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
  const auth_user_id_trimmed = typeof body.auth_user_id === "string" ? body.auth_user_id.trim() : body.auth_user_id;
  if (auth_user_id_trimmed && !isUuid(auth_user_id_trimmed)) {
    return { error: `auth_user_id must be a uuid (got: ${JSON.stringify(body.auth_user_id)})` };
  }
  const manager_id_trimmed = typeof body.manager_employee_id === "string" ? body.manager_employee_id.trim() : body.manager_employee_id;
  if (manager_id_trimmed && !isUuid(manager_id_trimmed)) {
    return { error: `manager_employee_id must be a uuid (got: ${JSON.stringify(body.manager_employee_id)})` };
  }
  // P16 — title_id / department_id FK pointers (uuid-or-null).
  const title_id_trimmed = typeof body.title_id === "string" ? body.title_id.trim() : body.title_id;
  if (title_id_trimmed && !isUuid(title_id_trimmed)) {
    return { error: `title_id must be a uuid (got: ${JSON.stringify(body.title_id)})` };
  }
  const department_id_trimmed = typeof body.department_id === "string" ? body.department_id.trim() : body.department_id;
  if (department_id_trimmed && !isUuid(department_id_trimmed)) {
    return { error: `department_id must be a uuid (got: ${JSON.stringify(body.department_id)})` };
  }
  // P16 — commission rates: numeric percent in 0..100.
  const wholesalePct = parsePct(body.commission_wholesale_pct);
  if (wholesalePct.error) return { error: `commission_wholesale_pct: ${wholesalePct.error}` };
  const closeoutPct = parsePct(body.commission_closeout_pct);
  if (closeoutPct.error) return { error: `commission_closeout_pct: ${closeoutPct.error}` };

  return {
    data: {
      code: String(body.code).trim().toUpperCase(),
      first_name: String(body.first_name).trim(),
      last_name: String(body.last_name).trim(),
      email: String(body.email).trim().toLowerCase(),
      title: body.title ? String(body.title).trim() : null,
      department: body.department ? String(body.department).trim() : null,
      title_id: title_id_trimmed || null,
      department_id: department_id_trimmed || null,
      commission_wholesale_pct: wholesalePct.value,
      commission_closeout_pct: closeoutPct.value,
      hire_date: body.hire_date || null,
      termination_date: body.termination_date || null,
      is_active: body.is_active !== false,
      phone: body.phone ? String(body.phone).trim() : null,
      auth_user_id: auth_user_id_trimmed || null,
      manager_employee_id: manager_id_trimmed || null,
      metadata: body.metadata || {},
    },
  };
}

// P16 — parse an optional commission percent. null/""/undefined → 0.
// Accepts a number or numeric string in [0, 100]. Returns { value } or { error }.
function parsePct(raw) {
  if (raw == null || raw === "") return { value: 0 };
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { error: "must be a number in [0, 100]" };
  }
  return { value: n };
}
