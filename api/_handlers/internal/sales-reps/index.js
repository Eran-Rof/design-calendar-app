// api/internal/sales-reps
//
// GET  — list sales_reps. Filters:
//          ?include_inactive=1  (default: only is_active=true)
//          ?q=<substring>       (case-insensitive ILIKE on display_name / email)
//          ?limit=N (default 200, max 500)
// POST — create a new sales rep.
//          Body:
//            {
//              display_name (required, non-empty),
//              email?,
//              default_commission_pct? (0..100, default 0),
//              payout_terms_days?      (>= 0, default 30),
//              employee_id?            (uuid),
//              is_active?              (default true),
//              created_by_user_id?     (uuid)
//            }
//
// Tangerine P7-6 (arch §4.4).
//
// Schema reference (per CURRENT-SCHEMA.md):
//   sales_reps(id, entity_id, employee_id, display_name, email,
//              default_commission_pct, payout_terms_days, is_active,
//              created_at, updated_at, created_by_user_id)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function resolveDefaultEntity(admin) {
  const { data } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
  const entityId = entity.id;

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const params = Object.fromEntries(url.searchParams.entries());
    const v = parseListQuery(params);
    if (v.error) return res.status(400).json({ error: v.error });

    let query = admin
      .from("sales_reps")
      .select(
        "id, entity_id, employee_id, display_name, email, " +
        "default_commission_pct, payout_terms_days, is_active, " +
        "created_at, updated_at, created_by_user_id",
      )
      .eq("entity_id", entityId)
      .order("display_name", { ascending: true })
      .limit(v.data.limit);

    if (!v.data.include_inactive) query = query.eq("is_active", true);
    if (v.data.q) query = query.or(`display_name.ilike.%${v.data.q}%,email.ilike.%${v.data.q}%`);

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

    const row = {
      entity_id: entityId,
      employee_id: v.data.employee_id,
      display_name: v.data.display_name,
      email: v.data.email,
      default_commission_pct: v.data.default_commission_pct,
      payout_terms_days: v.data.payout_terms_days,
      is_active: v.data.is_active,
      created_by_user_id: v.data.created_by_user_id,
    };

    const { data: inserted, error: insErr } = await admin
      .from("sales_reps")
      .insert(row)
      .select()
      .single();
    if (insErr) {
      if (insErr.code === "23505") {
        return res.status(409).json({ error: "sales_rep with that key already exists" });
      }
      return res.status(500).json({ error: insErr.message });
    }
    return res.status(201).json(inserted);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export function parseListQuery(params) {
  const q = (params.q || "").trim();
  const include_inactive = params.include_inactive === "1" ||
                           params.include_inactive === "true";

  let limit = parseInt(params.limit || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 500) limit = 500;

  if (q.length > 200) {
    return { error: "q must be ≤ 200 chars" };
  }

  return {
    data: {
      q: q || null,
      include_inactive,
      limit,
    },
  };
}

export function validateInsert(body) {
  const display_name = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!display_name) return { error: "display_name is required" };
  if (display_name.length > 200) return { error: "display_name must be ≤ 200 chars" };

  const email = body.email == null || body.email === "" ? null : String(body.email).trim();
  if (email !== null && email.length > 320) {
    return { error: "email must be ≤ 320 chars" };
  }

  let default_commission_pct = 0;
  if (body.default_commission_pct != null && body.default_commission_pct !== "") {
    const n = Number(body.default_commission_pct);
    if (!Number.isFinite(n)) return { error: "default_commission_pct must be a number" };
    if (n < 0 || n > 100) return { error: "default_commission_pct must be between 0 and 100" };
    default_commission_pct = n;
  }

  let payout_terms_days = 30;
  if (body.payout_terms_days != null && body.payout_terms_days !== "") {
    const n = Number(body.payout_terms_days);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "payout_terms_days must be a non-negative integer" };
    }
    payout_terms_days = n;
  }

  if (body.employee_id != null && body.employee_id !== "" && !UUID_RE.test(body.employee_id)) {
    return { error: "employee_id must be a uuid" };
  }
  if (body.created_by_user_id != null && body.created_by_user_id !== ""
      && !UUID_RE.test(body.created_by_user_id)) {
    return { error: "created_by_user_id must be a uuid" };
  }

  const is_active = body.is_active === undefined ? true : Boolean(body.is_active);

  return {
    data: {
      display_name,
      email,
      default_commission_pct,
      payout_terms_days,
      employee_id: body.employee_id || null,
      is_active,
      created_by_user_id: body.created_by_user_id || null,
    },
  };
}
