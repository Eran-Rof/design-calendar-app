// api/internal/procurement/compliance-certs/[id]
//
// Tangerine P13-6 — M48 vendor compliance certification detail handler.
//
// GET    — return single certification row.
// PATCH  — update fields (cert_number, certification_type, issued_at,
//          expires_at, document_url, status). Any subset.
// DELETE — destructive delete. Per T11 D3 the operator MUST supply a
//          non-empty reason (body { reason } or query ?reason=). The
//          reason is echoed in the response so the audit-log trigger
//          captures it.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATUS_VALUES = ["active", "expired", "revoked", "pending"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: cert, error: fetchErr } = await admin
    .from("vendor_compliance_certifications")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!cert) return res.status(404).json({ error: "Certification not found" });

  if (req.method === "GET") {
    return res.status(200).json(cert);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateCertPatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    // Cross-field: if both dates end up set, expires_at >= issued_at.
    const merged = { ...cert, ...v.data };
    if (merged.issued_at && merged.expires_at && merged.expires_at < merged.issued_at) {
      return res.status(400).json({ error: "expires_at must be on or after issued_at" });
    }

    const { data: updated, error: upErr } = await admin
      .from("vendor_compliance_certifications")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { body = {}; }
    }
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const v = validateCertDelete({ ...(body || {}), reason_query: url.searchParams.get("reason") });
    if (v.error) return res.status(400).json({ error: v.error });

    const { error: delErr } = await admin
      .from("vendor_compliance_certifications")
      .delete()
      .eq("id", id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ deleted: id, reason: v.data.reason });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export function validateCertPatch(body) {
  const out = {};

  if ("certification_type" in body) {
    const v = typeof body.certification_type === "string" ? body.certification_type.trim() : "";
    if (!v) return { error: "certification_type cannot be empty" };
    if (v.length > 200) return { error: "certification_type must be ≤ 200 chars" };
    out.certification_type = v;
  }
  if ("cert_number" in body) {
    if (body.cert_number === null || body.cert_number === "") {
      out.cert_number = null;
    } else {
      const v = String(body.cert_number).trim();
      if (v.length > 200) return { error: "cert_number must be ≤ 200 chars" };
      out.cert_number = v;
    }
  }
  if ("issued_at" in body) {
    if (body.issued_at === null || body.issued_at === "") {
      out.issued_at = null;
    } else if (typeof body.issued_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.issued_at)) {
      return { error: "issued_at must be YYYY-MM-DD" };
    } else {
      out.issued_at = body.issued_at;
    }
  }
  if ("expires_at" in body) {
    if (body.expires_at === null || body.expires_at === "") {
      out.expires_at = null;
    } else if (typeof body.expires_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.expires_at)) {
      return { error: "expires_at must be YYYY-MM-DD" };
    } else {
      out.expires_at = body.expires_at;
    }
  }
  if ("document_url" in body) {
    if (body.document_url === null || body.document_url === "") {
      out.document_url = null;
    } else {
      const v = String(body.document_url).trim();
      if (v.length > 1000) return { error: "document_url must be ≤ 1000 chars" };
      out.document_url = v;
    }
  }
  if ("status" in body) {
    if (!STATUS_VALUES.includes(body.status)) {
      return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
    }
    out.status = body.status;
  }

  return { data: out };
}

export function validateCertDelete(body) {
  // T11 D3 — destructive ops require an explicit reason for the audit log.
  const reason = (body.reason && String(body.reason).trim())
              || (body.reason_query && String(body.reason_query).trim())
              || "";
  if (!reason) {
    return { error: "reason is required for destructive delete (T11 D3)" };
  }
  if (reason.length > 500) {
    return { error: "reason must be ≤ 500 chars" };
  }
  return { data: { reason } };
}
