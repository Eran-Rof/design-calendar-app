// api/internal/employees
//
// GET  — list employees. Default: active only; ?include_inactive=true.
//        Query: ?q=<search> over code/first/last/email; ?department=<str>
// POST — create one. code + email unique per entity.
//
// Tangerine P2 Chunk 8.

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";
import { NOTIFICATION_CATEGORIES } from "../../../_lib/internal-recipients.js";

export const config = { maxDuration: 15 };

// Validate an employee.notification_subscriptions array: every entry must be a
// known notification category key. Returns a deduped array or an error string.
function parseSubscriptions(raw) {
  if (raw == null) return { value: [] };
  if (!Array.isArray(raw)) return { error: "notification_subscriptions must be an array of category keys" };
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") return { error: "notification_subscriptions entries must be strings" };
    const key = item.trim();
    if (!NOTIFICATION_CATEGORIES.includes(key)) return { error: `unknown notification category: ${JSON.stringify(item)}` };
    if (!out.includes(key)) out.push(key);
  }
  return { value: out };
}

// Internal app keys an employee may receive in-app notifications in.
// Mirrors the AppKey values in src/components/notifications/notificationApps.ts;
// the external vendor / b2b portals are intentionally excluded. A NULL apps
// column = all apps (back-compat).
const ALLOWED_APP_KEYS = ["tanda", "design", "ats", "techpack", "gs1", "planning", "rof"];

// Validate + normalize an `apps` value into a deduped string[] of allowed
// keys, or null (= all apps). An empty array normalizes to null so an
// operator who unchecks everything doesn't silence the employee everywhere.
// Returns { value } or { error }.
function parseApps(raw) {
  if (raw == null) return { value: null };
  if (!Array.isArray(raw)) return { error: "apps must be an array of app keys or null" };
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") return { error: "apps entries must be strings" };
    const key = item.trim();
    if (!key) continue;
    if (!ALLOWED_APP_KEYS.includes(key)) {
      return { error: `unknown app key: ${JSON.stringify(item)} (allowed: ${ALLOWED_APP_KEYS.join(", ")})` };
    }
    if (!out.includes(key)) out.push(key);
  }
  return { value: out.length > 0 ? out : null };
}

// The PLM-login link (app_data['users'].id slug) is stored inside the
// employee.metadata jsonb under `plm_user_id`. It's what lets the internal
// NotificationsShell — which matches the logged-in user by
// recipient_internal_id == app_data['users'].id — actually deliver an in-app
// notification to this person. Validate it's a short string or null and merge
// it into the metadata object. Returns { metadata } or { error }.
function mergePlmUserId(metadata, raw) {
  const base = (metadata && typeof metadata === "object" && !Array.isArray(metadata)) ? { ...metadata } : {};
  if (raw === undefined) return { metadata: base };
  if (raw === null || raw === "") { delete base.plm_user_id; return { metadata: base }; }
  if (typeof raw !== "string") return { error: "plm_user_id must be a string or null" };
  const id = raw.trim();
  if (!id) { delete base.plm_user_id; return { metadata: base }; }
  if (id.length > 64) return { error: "plm_user_id too long" };
  base.plm_user_id = id;
  return { metadata: base };
}

// Chunk M — employee codes are server-generated + read-only (operator item 14).
const CODE_PREFIX = "EMP-";

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

    // Chunk M — `code` is always server-generated; any client-supplied code is ignored.
    const { data, error } = await insertWithAutoCode(
      admin, "employees", "code", CODE_PREFIX,
      (code) => ({ ...v.data, code, entity_id: entityId }),
      { entityId },
    );
    if (error) {
      if (error.code === "23505") {
        // email collision (employee code is server-generated + retried, so a
        // 23505 that survives the retry is the (entity_id, email) unique index).
        return res.status(409).json({ error: `Employee with that email already exists for this entity` });
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
  // Chunk M — `code` is server-generated; no longer required from the client.
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
  const subs = parseSubscriptions(body.notification_subscriptions);
  if (subs.error) return { error: subs.error };
  const apps = parseApps(body.apps);
  if (apps.error) return { error: apps.error };
  const metaMerge = mergePlmUserId(body.metadata, body.plm_user_id);
  if (metaMerge.error) return { error: metaMerge.error };

  return {
    data: {
      // code is injected by the handler (server-generated); not taken from body.
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
      notification_subscriptions: subs.value,
      apps: apps.value,
      metadata: metaMerge.metadata,
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
