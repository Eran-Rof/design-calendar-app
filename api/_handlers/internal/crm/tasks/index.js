// api/internal/crm/tasks
//
// GET  — list tasks. Filters:
//          ?assignee_user_id=<uuid>
//          ?status=open|in_progress|done|cancelled
//          ?due_before=YYYY-MM-DD (due_date <=)
//          ?customer_id=<uuid>
//          ?opportunity_id=<uuid>
//          ?limit=N (default 100, max 500)
//          ?offset=N (default 0)
// POST — create new task.
//          Body:
//            {
//              title (required, non-empty),
//              description?,
//              customer_id?, opportunity_id?,
//              due_date?,
//              status? (default 'open'),
//              priority? (default 'normal'),
//              assignee_user_id?, created_by_user_id?
//            }
//
// Tangerine P8-2 (arch §4).
//
// Schema reference (per CURRENT-SCHEMA.md):
//   crm_tasks(id, entity_id, customer_id, opportunity_id, title, description,
//             due_date, status, priority, assignee_user_id, completed_at,
//             completed_by_user_id, created_at, updated_at, created_by_user_id)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_VALUES = ["open", "in_progress", "done", "cancelled"];
const PRIORITY_VALUES = ["low", "normal", "high", "urgent"];

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

    const { assignee_user_id, status, due_before, customer_id, opportunity_id, limit, offset } = v.data;

    let query = admin
      .from("crm_tasks")
      .select(
        "id, entity_id, customer_id, opportunity_id, title, description, " +
        "due_date, status, priority, assignee_user_id, completed_at, " +
        "completed_by_user_id, created_at, updated_at, created_by_user_id",
      )
      .eq("entity_id", entityId)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (assignee_user_id) query = query.eq("assignee_user_id", assignee_user_id);
    if (status)           query = query.eq("status", status);
    if (due_before)       query = query.lte("due_date", due_before);
    if (customer_id)      query = query.eq("customer_id", customer_id);
    if (opportunity_id)   query = query.eq("opportunity_id", opportunity_id);

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
      title: v.data.title,
      description: v.data.description,
      due_date: v.data.due_date,
      status: v.data.status,
      priority: v.data.priority,
      assignee_user_id: v.data.assignee_user_id,
      created_by_user_id: v.data.created_by_user_id,
    };

    const { data: inserted, error: insErr } = await admin
      .from("crm_tasks")
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
  const assignee_user_id = (params.assignee_user_id || "").trim();
  const status           = (params.status || "").trim();
  const due_before       = (params.due_before || "").trim();
  const customer_id      = (params.customer_id || "").trim();
  const opportunity_id   = (params.opportunity_id || "").trim();

  let limit = parseInt(params.limit || "100", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;
  let offset = parseInt(params.offset || "0", 10);
  if (Number.isNaN(offset) || offset < 0) offset = 0;

  if (status && !STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  if (assignee_user_id && !UUID_RE.test(assignee_user_id)) {
    return { error: "assignee_user_id must be a uuid" };
  }
  if (customer_id && !UUID_RE.test(customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (opportunity_id && !UUID_RE.test(opportunity_id)) {
    return { error: "opportunity_id must be a uuid" };
  }
  if (due_before && !DATE_RE.test(due_before)) {
    return { error: "due_before must be YYYY-MM-DD" };
  }

  return {
    data: {
      assignee_user_id: assignee_user_id || null,
      status: status || null,
      due_before: due_before || null,
      customer_id: customer_id || null,
      opportunity_id: opportunity_id || null,
      limit,
      offset,
    },
  };
}

export function validateInsert(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return { error: "title is required" };
  if (title.length > 500) return { error: "title must be ≤ 500 chars" };

  const status = body.status ? String(body.status).trim() : "open";
  if (!STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  const priority = body.priority ? String(body.priority).trim() : "normal";
  if (!PRIORITY_VALUES.includes(priority)) {
    return { error: `priority must be one of ${PRIORITY_VALUES.join(", ")}` };
  }

  if (body.customer_id && !UUID_RE.test(body.customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (body.opportunity_id && !UUID_RE.test(body.opportunity_id)) {
    return { error: "opportunity_id must be a uuid" };
  }
  if (body.assignee_user_id && !UUID_RE.test(body.assignee_user_id)) {
    return { error: "assignee_user_id must be a uuid" };
  }
  if (body.created_by_user_id && !UUID_RE.test(body.created_by_user_id)) {
    return { error: "created_by_user_id must be a uuid" };
  }

  let due_date = null;
  if (body.due_date) {
    const d = String(body.due_date).trim();
    if (!DATE_RE.test(d)) return { error: "due_date must be YYYY-MM-DD" };
    due_date = d;
  }

  return {
    data: {
      title,
      description: body.description ? String(body.description) : null,
      status,
      priority,
      due_date,
      customer_id: body.customer_id || null,
      opportunity_id: body.opportunity_id || null,
      assignee_user_id: body.assignee_user_id || null,
      created_by_user_id: body.created_by_user_id || null,
    },
  };
}
