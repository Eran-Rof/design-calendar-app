// api/internal/crm/activities
//
// GET  — list activities. Filters:
//          ?customer_id=<uuid>
//          ?opportunity_id=<uuid>
//          ?activity_type=note|call|email_in|email_out|meeting|task_done|stage_change|system
//          ?from=YYYY-MM-DD (occurred_at >=)
//          ?to=YYYY-MM-DD   (occurred_at <=)
//          ?include_hidden=true (default false → is_hidden=false only)
//          ?limit=N (default 100, max 500)
//          ?offset=N (default 0)
// POST — manually log an activity.
//          Body:
//            {
//              activity_type (required, in enum, but NOT 'stage_change' — RPC writes those),
//              subject (required, non-empty),
//              body?,
//              customer_id?, opportunity_id?, case_id?,
//              occurred_at? (timestamptz, defaults now()),
//              duration_minutes? (int >= 0),
//              external_email?, payload?,
//              created_by_user_id?
//            }
//
// Tangerine P8-2 (arch §4).
//
// Schema reference (per CURRENT-SCHEMA.md):
//   crm_activities(id, entity_id, customer_id, opportunity_id, case_id,
//                  activity_type, subject, body, occurred_at, duration_minutes,
//                  external_email, payload, is_hidden, created_at,
//                  created_by_user_id)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVITY_TYPES = [
  "note", "call", "email_in", "email_out", "meeting",
  "task_done", "stage_change", "system",
];
// Server-side enforce: trigger-only activity types may not be inserted via handler.
const TRIGGER_ONLY_TYPES = new Set(["stage_change", "task_done"]);

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

    const { customer_id, opportunity_id, activity_type, from, to, include_hidden, limit, offset } = v.data;

    let query = admin
      .from("crm_activities")
      .select(
        "id, entity_id, customer_id, opportunity_id, case_id, activity_type, " +
        "subject, body, occurred_at, duration_minutes, external_email, " +
        "payload, is_hidden, created_at, created_by_user_id",
      )
      .eq("entity_id", entityId)
      .order("occurred_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (customer_id)    query = query.eq("customer_id", customer_id);
    if (opportunity_id) query = query.eq("opportunity_id", opportunity_id);
    if (activity_type)  query = query.eq("activity_type", activity_type);
    if (from)           query = query.gte("occurred_at", `${from}T00:00:00Z`);
    if (to)             query = query.lte("occurred_at", `${to}T23:59:59Z`);
    if (!include_hidden) query = query.eq("is_hidden", false);

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
      customer_id: v.data.customer_id,
      opportunity_id: v.data.opportunity_id,
      case_id: v.data.case_id,
      activity_type: v.data.activity_type,
      subject: v.data.subject,
      body: v.data.body,
      occurred_at: v.data.occurred_at,
      duration_minutes: v.data.duration_minutes,
      external_email: v.data.external_email,
      payload: v.data.payload,
      created_by_user_id: v.data.created_by_user_id,
    };

    const { data: inserted, error: insErr } = await admin
      .from("crm_activities")
      .insert(row)
      .select()
      .single();
    if (insErr) return res.status(500).json({ error: insErr.message });
    return res.status(201).json(inserted);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function parseListQuery(params) {
  const customer_id    = (params.customer_id || "").trim();
  const opportunity_id = (params.opportunity_id || "").trim();
  const activity_type  = (params.activity_type || "").trim();
  const from           = (params.from || "").trim();
  const to             = (params.to || "").trim();
  const include_hidden = String(params.include_hidden || "").toLowerCase() === "true";

  let limit = parseInt(params.limit || "100", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;
  let offset = parseInt(params.offset || "0", 10);
  if (Number.isNaN(offset) || offset < 0) offset = 0;

  if (customer_id && !UUID_RE.test(customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (opportunity_id && !UUID_RE.test(opportunity_id)) {
    return { error: "opportunity_id must be a uuid" };
  }
  if (activity_type && !ACTIVITY_TYPES.includes(activity_type)) {
    return { error: `activity_type must be one of ${ACTIVITY_TYPES.join(", ")}` };
  }
  if (from && !DATE_RE.test(from)) {
    return { error: "from must be YYYY-MM-DD" };
  }
  if (to && !DATE_RE.test(to)) {
    return { error: "to must be YYYY-MM-DD" };
  }

  return {
    data: {
      customer_id: customer_id || null,
      opportunity_id: opportunity_id || null,
      activity_type: activity_type || null,
      from: from || null,
      to: to || null,
      include_hidden,
      limit,
      offset,
    },
  };
}

export function validateInsert(body) {
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!subject) return { error: "subject is required" };
  if (subject.length > 500) return { error: "subject must be ≤ 500 chars" };

  const activity_type = body.activity_type ? String(body.activity_type).trim() : "";
  if (!ACTIVITY_TYPES.includes(activity_type)) {
    return { error: `activity_type must be one of ${ACTIVITY_TYPES.join(", ")}` };
  }
  if (TRIGGER_ONLY_TYPES.has(activity_type)) {
    return { error: `activity_type=${activity_type} is reserved for trigger-driven inserts` };
  }

  if (body.customer_id && !UUID_RE.test(body.customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (body.opportunity_id && !UUID_RE.test(body.opportunity_id)) {
    return { error: "opportunity_id must be a uuid" };
  }
  if (body.case_id && !UUID_RE.test(body.case_id)) {
    return { error: "case_id must be a uuid" };
  }
  if (body.created_by_user_id && !UUID_RE.test(body.created_by_user_id)) {
    return { error: "created_by_user_id must be a uuid" };
  }

  let duration_minutes = null;
  if (body.duration_minutes !== undefined && body.duration_minutes !== null && body.duration_minutes !== "") {
    const n = Number(body.duration_minutes);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return { error: "duration_minutes must be a non-negative integer" };
    }
    duration_minutes = n;
  }

  let occurred_at = null;
  if (body.occurred_at) {
    const s = String(body.occurred_at).trim();
    // Accept ISO timestamps; also bare YYYY-MM-DD which Postgres can coerce.
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) {
      return { error: "occurred_at must be an ISO timestamp" };
    }
    occurred_at = s;
  }

  let payload = {};
  if (body.payload !== undefined && body.payload !== null) {
    if (typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return { error: "payload must be an object" };
    }
    payload = body.payload;
  }

  return {
    data: {
      activity_type,
      subject,
      body: body.body == null ? null : String(body.body),
      customer_id: body.customer_id || null,
      opportunity_id: body.opportunity_id || null,
      case_id: body.case_id || null,
      occurred_at,
      duration_minutes,
      external_email: body.external_email ? String(body.external_email).trim() : null,
      payload,
      created_by_user_id: body.created_by_user_id || null,
    },
  };
}
