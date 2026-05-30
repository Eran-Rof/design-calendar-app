// api/internal/procurement/import-docs
//
// Tangerine P13-6 — M48 per-PO import documentation list + create.
//
// GET   — list import_documentation. Optional query:
//           ?tanda_po_id=<uuid>
//           ?status=<pending|received|verified|filed>
//           ?document_type=<commercial_invoice|packing_list|bill_of_lading|certificate_of_origin|customs_declaration>
//           ?limit=N (default 200, max 500)
//
// POST  — create a new import documentation row. Body:
//           {
//             tanda_po_id (uuid, required),
//             document_type (text, required; preset list),
//             document_url? (text — M29 attachment URL),
//             hs_code? (text),
//             country_of_origin? (text — ISO-3166 alpha-2 / 3 or free text),
//             declared_value_cents? (int >= 0),
//             duty_rate_pct? (numeric 0..100),
//             status? (default 'pending')
//           }
//
// FK note: tanda_po_id → tanda_pos(id). Per the T5 backfill migration
// tanda_pos.id IS a uuid PK, so the FK is uuid→uuid. The compliance-status
// /po/:uuid_id route uses path param uuid_id naming purely to be explicit
// per the memory rule that procurement code MUST use the uuid form when
// referencing tanda_pos.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATUS_VALUES = ["pending", "received", "verified", "filed"];
export const DOCUMENT_TYPES = [
  "commercial_invoice",
  "packing_list",
  "bill_of_lading",
  "certificate_of_origin",
  "customs_declaration",
];

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
      .from("import_documentation")
      .select(
        "id, entity_id, tanda_po_id, document_type, document_url, " +
        "hs_code, country_of_origin, declared_value_cents, duty_rate_pct, " +
        "status, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(v.data.limit);

    if (v.data.tanda_po_id)  query = query.eq("tanda_po_id", v.data.tanda_po_id);
    if (v.data.status)       query = query.eq("status", v.data.status);
    if (v.data.document_type) query = query.eq("document_type", v.data.document_type);

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
    const v = validateImportDocInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const entityId = await resolveDefaultEntity(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const { data: inserted, error: insErr } = await admin
      .from("import_documentation")
      .insert({
        entity_id: entityId,
        tanda_po_id: v.data.tanda_po_id,
        document_type: v.data.document_type,
        document_url: v.data.document_url,
        hs_code: v.data.hs_code,
        country_of_origin: v.data.country_of_origin,
        declared_value_cents: v.data.declared_value_cents,
        duty_rate_pct: v.data.duty_rate_pct,
        status: v.data.status,
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
  const tanda_po_id   = (params.tanda_po_id || "").trim();
  const status        = (params.status || "").trim();
  const document_type = (params.document_type || "").trim();

  let limit = parseInt(params.limit || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 500) limit = 500;

  if (tanda_po_id && !UUID_RE.test(tanda_po_id)) {
    return { error: "tanda_po_id must be a uuid" };
  }
  if (status && !STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  if (document_type && !DOCUMENT_TYPES.includes(document_type)) {
    return { error: `document_type must be one of ${DOCUMENT_TYPES.join(", ")}` };
  }

  return {
    data: {
      tanda_po_id: tanda_po_id || null,
      status: status || null,
      document_type: document_type || null,
      limit,
    },
  };
}

export function validateImportDocInsert(body) {
  if (!body.tanda_po_id || !isUuid(body.tanda_po_id)) {
    return { error: "tanda_po_id (uuid) is required" };
  }
  const docType = typeof body.document_type === "string" ? body.document_type.trim() : "";
  if (!DOCUMENT_TYPES.includes(docType)) {
    return { error: `document_type must be one of ${DOCUMENT_TYPES.join(", ")}` };
  }

  const document_url = body.document_url ? String(body.document_url).trim() : null;
  if (document_url !== null && document_url.length > 1000) {
    return { error: "document_url must be ≤ 1000 chars" };
  }

  const hs_code = body.hs_code ? String(body.hs_code).trim() : null;
  if (hs_code !== null && hs_code.length > 50) {
    return { error: "hs_code must be ≤ 50 chars" };
  }

  const country_of_origin = body.country_of_origin
    ? String(body.country_of_origin).trim()
    : null;
  if (country_of_origin !== null && country_of_origin.length > 100) {
    return { error: "country_of_origin must be ≤ 100 chars" };
  }

  let declared_value_cents = null;
  if (body.declared_value_cents !== undefined && body.declared_value_cents !== null && body.declared_value_cents !== "") {
    const n = typeof body.declared_value_cents === "number"
      ? body.declared_value_cents
      : parseInt(body.declared_value_cents, 10);
    if (!Number.isFinite(n) || n < 0) {
      return { error: "declared_value_cents must be >= 0" };
    }
    declared_value_cents = n;
  }

  let duty_rate_pct = null;
  if (body.duty_rate_pct !== undefined && body.duty_rate_pct !== null && body.duty_rate_pct !== "") {
    const n = typeof body.duty_rate_pct === "number"
      ? body.duty_rate_pct
      : parseFloat(body.duty_rate_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { error: "duty_rate_pct must be a number 0..100" };
    }
    duty_rate_pct = n;
  }

  const status = body.status ? String(body.status).trim() : "pending";
  if (!STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }

  return {
    data: {
      tanda_po_id: body.tanda_po_id,
      document_type: docType,
      document_url,
      hs_code,
      country_of_origin,
      declared_value_cents,
      duty_rate_pct,
      status,
    },
  };
}
