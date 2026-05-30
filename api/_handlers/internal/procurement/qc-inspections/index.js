// api/internal/procurement/qc-inspections
//
// Tangerine P13-5 — M26 QC inspection list + create.
//
// GET   — list tanda_po_qc_inspections.
//          Default filter: status IN ('pending','failed','partial') (the
//          "open" QC queue). Optional:
//            ?status=<pending|passed|failed|partial>
//            ?receipt_id=<uuid>
//            ?from / ?to   (inspection_date window)
//            ?limit=N (default 200, max 500)
//            ?include_passed=true
//
// POST  — create a new draft inspection. Body:
//            {
//              receipt_id (uuid, required),
//              inspection_date (YYYY-MM-DD; defaults today),
//              inspector_employee_id? (uuid),
//              status? (default 'pending'),
//              overall_pass_rate? (numeric 0..1),
//              notes?
//            }
//
// QC inspections reference tanda_po_receipts(id) which IS a uuid PK on the
// new Tangerine-native receipt table — no contact with the legacy
// tanda_pos.id bigint column here, so the FK convention is safe.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ["pending", "passed", "failed", "partial"];
const OPEN_STATUSES = ["pending", "failed", "partial"];

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
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const v = parseListQuery(Object.fromEntries(url.searchParams.entries()));
    if (v.error) return res.status(400).json({ error: v.error });

    let query = admin
      .from("tanda_po_qc_inspections")
      .select(
        "id, entity_id, receipt_id, inspection_date, inspector_employee_id, " +
        "status, overall_pass_rate, notes, case_id, created_at",
      )
      .order("inspection_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(v.data.limit);

    if (v.data.status) {
      query = query.eq("status", v.data.status);
    } else if (!v.data.include_passed) {
      query = query.in("status", OPEN_STATUSES);
    }
    if (v.data.receipt_id) query = query.eq("receipt_id", v.data.receipt_id);
    if (v.data.from) query = query.gte("inspection_date", v.data.from);
    if (v.data.to)   query = query.lte("inspection_date", v.data.to);

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
    const v = validateInspectionInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const entityId = await resolveDefaultEntity(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const { data: inserted, error: insErr } = await admin
      .from("tanda_po_qc_inspections")
      .insert({
        entity_id: entityId,
        receipt_id: v.data.receipt_id,
        inspection_date: v.data.inspection_date,
        inspector_employee_id: v.data.inspector_employee_id,
        status: v.data.status,
        overall_pass_rate: v.data.overall_pass_rate,
        notes: v.data.notes,
      })
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

export function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export function parseListQuery(params) {
  const status     = (params.status || "").trim();
  const receipt_id = (params.receipt_id || "").trim();
  const from       = (params.from || "").trim();
  const to         = (params.to || "").trim();
  const include_passed = params.include_passed === "true";

  let limit = parseInt(params.limit || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 500) limit = 500;

  if (status && !STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  if (receipt_id && !UUID_RE.test(receipt_id)) {
    return { error: "receipt_id must be a uuid" };
  }
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return { error: "from must be YYYY-MM-DD" };
  }
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { error: "to must be YYYY-MM-DD" };
  }

  return {
    data: {
      status: status || null,
      receipt_id: receipt_id || null,
      from: from || null,
      to: to || null,
      include_passed,
      limit,
    },
  };
}

export function validateInspectionInsert(body) {
  if (!body.receipt_id || !isUuid(body.receipt_id)) {
    return { error: "receipt_id (uuid) is required" };
  }
  const date = body.inspection_date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: "inspection_date must be YYYY-MM-DD" };
  }
  if (body.inspector_employee_id && !isUuid(body.inspector_employee_id)) {
    return { error: "inspector_employee_id must be a uuid" };
  }
  const status = body.status ? String(body.status).trim() : "pending";
  if (!STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  let overall_pass_rate = null;
  if (body.overall_pass_rate !== undefined && body.overall_pass_rate !== null && body.overall_pass_rate !== "") {
    const n = typeof body.overall_pass_rate === "number"
      ? body.overall_pass_rate
      : parseFloat(body.overall_pass_rate);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return { error: "overall_pass_rate must be a number 0..1" };
    }
    overall_pass_rate = n;
  }
  return {
    data: {
      receipt_id: body.receipt_id,
      inspection_date: date,
      inspector_employee_id: body.inspector_employee_id || null,
      status,
      overall_pass_rate,
      notes: body.notes ? String(body.notes).trim() : null,
    },
  };
}
