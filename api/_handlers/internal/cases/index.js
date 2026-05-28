// api/internal/cases
//
// GET  — list cases. Filters:
//          ?status=open|in_progress|resolved|closed
//          ?severity=low|normal|high|urgent
//          ?assignee_user_id=<uuid>
//          ?customer_id=<uuid>
//          ?q=<substring>  (case-insensitive ILIKE on subject)
//          ?limit=N (default 100, max 500)
//          ?offset=N (default 0)
// POST — create new case.
//          Body:
//            {
//              subject (required, non-empty),
//              body?,
//              customer_id?, ar_invoice_id?, rma_id?, sales_order_id?,
//              status?  (default 'open'),
//              severity? (default 'normal'),
//              assignee_user_id?,
//              created_by_user_id?
//            }
//          Server generates case_number CASE-YYYY-NNNNN if not supplied;
//          uniqueness is per (entity, case_number).
//
// Tangerine P7-9 (arch §6).
//
// Schema reference (per CURRENT-SCHEMA.md):
//   cases(id, entity_id, case_number, customer_id, ar_invoice_id, rma_id,
//         sales_order_id, status, severity, subject, body, assignee_user_id,
//         external_email, resolved_at, created_at, updated_at,
//         created_by_user_id)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ["open", "in_progress", "resolved", "closed"];
const SEVERITY_VALUES = ["low", "normal", "high", "urgent"];

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

/**
 * Generate the next case_number for an entity in YYYY year-bucket.
 * Format: CASE-YYYY-NNNNN (5-digit zero-padded sequence per year).
 *
 * Reads the max existing case_number for the year prefix and increments.
 * Race-safe enough for low volume (~50/year per spec); the per-entity
 * unique constraint catches collisions.
 */
export async function nextCaseNumber(admin, entityId, year) {
  const prefix = `CASE-${year}-`;
  const { data } = await admin
    .from("cases")
    .select("case_number")
    .eq("entity_id", entityId)
    .like("case_number", `${prefix}%`)
    .order("case_number", { ascending: false })
    .limit(1);
  let next = 1;
  if (Array.isArray(data) && data.length > 0) {
    const last = data[0].case_number;
    const m = /^CASE-\d{4}-(\d+)$/.exec(last || "");
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(next).padStart(5, "0")}`;
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

    const { status, severity, assignee_user_id, customer_id, q, limit, offset } = v.data;

    let query = admin
      .from("cases")
      .select(
        "id, entity_id, case_number, customer_id, ar_invoice_id, rma_id, " +
        "sales_order_id, status, severity, subject, body, assignee_user_id, " +
        "external_email, resolved_at, created_at, updated_at, created_by_user_id",
      )
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status)           query = query.eq("status", status);
    if (severity)         query = query.eq("severity", severity);
    if (assignee_user_id) query = query.eq("assignee_user_id", assignee_user_id);
    if (customer_id)      query = query.eq("customer_id", customer_id);
    if (q)                query = query.ilike("subject", `%${q}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Enrich with customer name (best-effort, single batch fetch).
    const customerIds = Array.from(new Set((data || []).map((r) => r.customer_id).filter(Boolean)));
    let customers = {};
    if (customerIds.length > 0) {
      const { data: custData } = await admin
        .from("customers")
        .select("id, code, name")
        .in("id", customerIds);
      for (const c of custData || []) customers[c.id] = c;
    }

    // Enrich with last-activity timestamp (latest case_comment.created_at, else
    // the case row's updated_at).
    const caseIds = (data || []).map((r) => r.id);
    let lastActivity = {};
    if (caseIds.length > 0) {
      const { data: commentData } = await admin
        .from("case_comments")
        .select("case_id, created_at")
        .in("case_id", caseIds)
        .order("created_at", { ascending: false });
      for (const c of commentData || []) {
        if (!lastActivity[c.case_id]) lastActivity[c.case_id] = c.created_at;
      }
    }

    const enriched = (data || []).map((r) => ({
      ...r,
      customer: r.customer_id ? customers[r.customer_id] || null : null,
      last_activity_at: lastActivity[r.id] || r.updated_at,
    }));
    return res.status(200).json(enriched);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const year = new Date().getUTCFullYear();
    const caseNumber = v.data.case_number || (await nextCaseNumber(admin, entityId, year));

    const row = {
      entity_id: entityId,
      case_number: caseNumber,
      customer_id: v.data.customer_id,
      ar_invoice_id: v.data.ar_invoice_id,
      rma_id: v.data.rma_id,
      sales_order_id: v.data.sales_order_id,
      status: v.data.status,
      severity: v.data.severity,
      subject: v.data.subject,
      body: v.data.body,
      assignee_user_id: v.data.assignee_user_id,
      external_email: v.data.external_email,
      created_by_user_id: v.data.created_by_user_id,
    };

    const { data: inserted, error: insErr } = await admin
      .from("cases")
      .insert(row)
      .select()
      .single();
    if (insErr) {
      if (insErr.code === "23505") {
        return res.status(409).json({ error: `case_number ${caseNumber} already exists for this entity` });
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
  const status           = (params.status || "").trim();
  const severity         = (params.severity || "").trim();
  const assignee_user_id = (params.assignee_user_id || "").trim();
  const customer_id      = (params.customer_id || "").trim();
  const q                = (params.q || "").trim();

  let limit = parseInt(params.limit || "100", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;
  let offset = parseInt(params.offset || "0", 10);
  if (Number.isNaN(offset) || offset < 0) offset = 0;

  if (status && !STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  if (severity && !SEVERITY_VALUES.includes(severity)) {
    return { error: `severity must be one of ${SEVERITY_VALUES.join(", ")}` };
  }
  if (assignee_user_id && !UUID_RE.test(assignee_user_id)) {
    return { error: "assignee_user_id must be a uuid" };
  }
  if (customer_id && !UUID_RE.test(customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (q.length > 200) {
    return { error: "q must be ≤ 200 chars" };
  }

  return {
    data: {
      status: status || null,
      severity: severity || null,
      assignee_user_id: assignee_user_id || null,
      customer_id: customer_id || null,
      q: q || null,
      limit,
      offset,
    },
  };
}

export function validateInsert(body) {
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!subject) return { error: "subject is required" };
  if (subject.length > 500) return { error: "subject must be ≤ 500 chars" };

  const status = body.status ? String(body.status).trim() : "open";
  if (!STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  const severity = body.severity ? String(body.severity).trim() : "normal";
  if (!SEVERITY_VALUES.includes(severity)) {
    return { error: `severity must be one of ${SEVERITY_VALUES.join(", ")}` };
  }

  if (body.customer_id && !UUID_RE.test(body.customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (body.ar_invoice_id && !UUID_RE.test(body.ar_invoice_id)) {
    return { error: "ar_invoice_id must be a uuid" };
  }
  if (body.rma_id && !UUID_RE.test(body.rma_id)) {
    return { error: "rma_id must be a uuid" };
  }
  if (body.sales_order_id && !UUID_RE.test(body.sales_order_id)) {
    return { error: "sales_order_id must be a uuid" };
  }
  if (body.assignee_user_id && !UUID_RE.test(body.assignee_user_id)) {
    return { error: "assignee_user_id must be a uuid" };
  }
  if (body.created_by_user_id && !UUID_RE.test(body.created_by_user_id)) {
    return { error: "created_by_user_id must be a uuid" };
  }
  if (body.case_number !== undefined && body.case_number !== null && body.case_number !== "") {
    const cn = String(body.case_number).trim();
    if (!/^CASE-\d{4}-\d{5,}$/.test(cn)) {
      return { error: "case_number must match CASE-YYYY-NNNNN" };
    }
  }

  return {
    data: {
      subject,
      body: body.body ? String(body.body) : null,
      status,
      severity,
      customer_id: body.customer_id || null,
      ar_invoice_id: body.ar_invoice_id || null,
      rma_id: body.rma_id || null,
      sales_order_id: body.sales_order_id || null,
      assignee_user_id: body.assignee_user_id || null,
      external_email: body.external_email ? String(body.external_email).trim() : null,
      created_by_user_id: body.created_by_user_id || null,
      case_number: body.case_number ? String(body.case_number).trim() : null,
    },
  };
}
