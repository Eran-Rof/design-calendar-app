// api/internal/procurement/import-docs/[id]
//
// Tangerine P13-6 — M48 import documentation detail handler.
//
// GET    — return single import_documentation row.
// PATCH  — update fields (document_type, document_url, hs_code,
//          country_of_origin, declared_value_cents, duty_rate_pct,
//          status). Any subset.
// DELETE — destructive delete. Per T11 D3 the operator MUST supply a
//          non-empty reason (body { reason } or query ?reason=). The
//          reason is echoed in the response so the audit-log trigger
//          captures it.

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

  const { data: row, error: fetchErr } = await admin
    .from("import_documentation")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "Import documentation not found" });

  if (req.method === "GET") {
    return res.status(200).json(row);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateImportDocPatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const { data: updated, error: upErr } = await admin
      .from("import_documentation")
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
    const v = validateImportDocDelete({ ...(body || {}), reason_query: url.searchParams.get("reason") });
    if (v.error) return res.status(400).json({ error: v.error });

    const { error: delErr } = await admin
      .from("import_documentation")
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

export function validateImportDocPatch(body) {
  const out = {};

  if ("document_type" in body) {
    if (!DOCUMENT_TYPES.includes(body.document_type)) {
      return { error: `document_type must be one of ${DOCUMENT_TYPES.join(", ")}` };
    }
    out.document_type = body.document_type;
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
  if ("hs_code" in body) {
    if (body.hs_code === null || body.hs_code === "") {
      out.hs_code = null;
    } else {
      const v = String(body.hs_code).trim();
      if (v.length > 50) return { error: "hs_code must be ≤ 50 chars" };
      out.hs_code = v;
    }
  }
  if ("country_of_origin" in body) {
    if (body.country_of_origin === null || body.country_of_origin === "") {
      out.country_of_origin = null;
    } else {
      const v = String(body.country_of_origin).trim();
      if (v.length > 100) return { error: "country_of_origin must be ≤ 100 chars" };
      out.country_of_origin = v;
    }
  }
  if ("declared_value_cents" in body) {
    if (body.declared_value_cents === null || body.declared_value_cents === "") {
      out.declared_value_cents = null;
    } else {
      const n = typeof body.declared_value_cents === "number"
        ? body.declared_value_cents
        : parseInt(body.declared_value_cents, 10);
      if (!Number.isFinite(n) || n < 0) {
        return { error: "declared_value_cents must be >= 0" };
      }
      out.declared_value_cents = n;
    }
  }
  if ("duty_rate_pct" in body) {
    if (body.duty_rate_pct === null || body.duty_rate_pct === "") {
      out.duty_rate_pct = null;
    } else {
      const n = typeof body.duty_rate_pct === "number"
        ? body.duty_rate_pct
        : parseFloat(body.duty_rate_pct);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return { error: "duty_rate_pct must be a number 0..100" };
      }
      out.duty_rate_pct = n;
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

export function validateImportDocDelete(body) {
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
