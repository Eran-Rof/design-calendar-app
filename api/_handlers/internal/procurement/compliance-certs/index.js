// api/internal/procurement/compliance-certs
//
// Tangerine P13-6 — M48 vendor compliance certifications list + create.
//
// GET   — list vendor_compliance_certifications. Optional query:
//           ?status=<active|expired|revoked|pending>
//           ?vendor_id=<uuid>
//           ?certification_type=<OEKO-TEX|GOTS|BSCI|WRAP|ISO9001|custom>
//           ?expiring_within_days=N   ("expiring soon" chip; default 60)
//           ?from / ?to               (window on expires_at)
//           ?limit=N (default 200, max 500)
//           ?include_inactive=true    (include expired/revoked rows)
//        Default scope: status='active' rows when neither status nor
//        include_inactive supplied.
//
// POST  — create a new certification. Body:
//           {
//             vendor_id (uuid, required),
//             certification_type (text, required; preset OR custom),
//             cert_number?,
//             issued_at? (YYYY-MM-DD),
//             expires_at? (YYYY-MM-DD),
//             document_url? (text — M29 attachment URL),
//             status? (default 'active')
//           }
//
// FK: vendor_id → vendors(id) (uuid PK). The handler does NOT touch
// tanda_pos here, so the uuid_id vs id memory rule is not in play.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATUS_VALUES = ["active", "expired", "revoked", "pending"];
export const PRESET_CERT_TYPES = ["OEKO-TEX", "GOTS", "BSCI", "WRAP", "ISO9001", "custom"];

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
      .from("vendor_compliance_certifications")
      .select(
        "id, entity_id, vendor_id, certification_type, cert_number, " +
        "issued_at, expires_at, document_url, status, created_at",
      )
      .order("expires_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(v.data.limit);

    if (v.data.status) {
      query = query.eq("status", v.data.status);
    } else if (!v.data.include_inactive) {
      query = query.eq("status", "active");
    }
    if (v.data.vendor_id) query = query.eq("vendor_id", v.data.vendor_id);
    if (v.data.certification_type) query = query.eq("certification_type", v.data.certification_type);
    if (v.data.from) query = query.gte("expires_at", v.data.from);
    if (v.data.to)   query = query.lte("expires_at", v.data.to);

    if (v.data.expiring_within_days !== null) {
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.now() + v.data.expiring_within_days * 86400000).toISOString().slice(0, 10);
      query = query.gte("expires_at", today).lte("expires_at", future);
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
    const v = validateCertInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const entityId = await resolveDefaultEntity(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const { data: inserted, error: insErr } = await admin
      .from("vendor_compliance_certifications")
      .insert({
        entity_id: entityId,
        vendor_id: v.data.vendor_id,
        certification_type: v.data.certification_type,
        cert_number: v.data.cert_number,
        issued_at: v.data.issued_at,
        expires_at: v.data.expires_at,
        document_url: v.data.document_url,
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
  const status     = (params.status || "").trim();
  const vendor_id  = (params.vendor_id || "").trim();
  const cert_type  = (params.certification_type || "").trim();
  const from       = (params.from || "").trim();
  const to         = (params.to || "").trim();
  const include_inactive = params.include_inactive === "true";

  let limit = parseInt(params.limit || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 500) limit = 500;

  let expiring_within_days = null;
  if (params.expiring_within_days !== undefined && params.expiring_within_days !== "") {
    const n = parseInt(params.expiring_within_days, 10);
    if (!Number.isFinite(n) || n < 1 || n > 3650) {
      return { error: "expiring_within_days must be a positive integer ≤ 3650" };
    }
    expiring_within_days = n;
  }

  if (status && !STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  if (vendor_id && !UUID_RE.test(vendor_id)) {
    return { error: "vendor_id must be a uuid" };
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
      vendor_id: vendor_id || null,
      certification_type: cert_type || null,
      from: from || null,
      to: to || null,
      include_inactive,
      expiring_within_days,
      limit,
    },
  };
}

export function validateCertInsert(body) {
  if (!body.vendor_id || !isUuid(body.vendor_id)) {
    return { error: "vendor_id (uuid) is required" };
  }
  const certType = typeof body.certification_type === "string" ? body.certification_type.trim() : "";
  if (!certType) return { error: "certification_type is required" };
  if (certType.length > 200) return { error: "certification_type must be ≤ 200 chars" };

  const certNumber = body.cert_number === undefined || body.cert_number === null || body.cert_number === ""
    ? null
    : String(body.cert_number).trim();
  if (certNumber !== null && certNumber.length > 200) {
    return { error: "cert_number must be ≤ 200 chars" };
  }

  const issued_at  = validateOptionalDate(body.issued_at, "issued_at");
  if (issued_at.error)  return { error: issued_at.error };
  const expires_at = validateOptionalDate(body.expires_at, "expires_at");
  if (expires_at.error) return { error: expires_at.error };

  if (issued_at.value && expires_at.value && expires_at.value < issued_at.value) {
    return { error: "expires_at must be on or after issued_at" };
  }

  const document_url = body.document_url ? String(body.document_url).trim() : null;
  if (document_url !== null && document_url.length > 1000) {
    return { error: "document_url must be ≤ 1000 chars" };
  }

  const status = body.status ? String(body.status).trim() : "active";
  if (!STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }

  return {
    data: {
      vendor_id: body.vendor_id,
      certification_type: certType,
      cert_number: certNumber,
      issued_at: issued_at.value,
      expires_at: expires_at.value,
      document_url,
      status,
    },
  };
}

function validateOptionalDate(value, field) {
  if (value === undefined || value === null || value === "") {
    return { value: null };
  }
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { error: `${field} must be YYYY-MM-DD` };
  }
  return { value: s };
}
