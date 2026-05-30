// api/internal/procurement/qc-findings/[id]
//
// Tangerine P13-5 — M26 QC finding update + delete.
//
// PATCH  — update one finding (category, severity, qty_affected,
//          description, photo_urls, resolution). Any subset.
// DELETE — destructive delete of a finding. Per T11 D3 the operator MUST
//          supply a non-empty reason (body { reason } or query ?reason=).
//          The reason is echoed in the response so the audit-log trigger
//          captures it.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVERITY_VALUES = ["minor", "major", "critical"];

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

  const { data: finding, error: fetchErr } = await admin
    .from("tanda_po_qc_findings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!finding) return res.status(404).json({ error: "Finding not found" });

  if (req.method === "GET") {
    return res.status(200).json(finding);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateFindingPatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const { data: updated, error: upErr } = await admin
      .from("tanda_po_qc_findings")
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
    const v = validateFindingDelete({ ...(body || {}), reason_query: url.searchParams.get("reason") });
    if (v.error) return res.status(400).json({ error: v.error });

    const { error: delErr } = await admin
      .from("tanda_po_qc_findings")
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

function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export function validateFindingPatch(body) {
  const out = {};

  if ("category" in body) {
    const v = typeof body.category === "string" ? body.category.trim() : "";
    if (!v) return { error: "category cannot be empty" };
    if (v.length > 200) return { error: "category must be ≤ 200 chars" };
    out.category = v;
  }
  if ("severity" in body) {
    if (!SEVERITY_VALUES.includes(body.severity)) {
      return { error: `severity must be one of ${SEVERITY_VALUES.join(", ")}` };
    }
    out.severity = body.severity;
  }
  if ("qty_affected" in body) {
    const n = parseInt(body.qty_affected, 10);
    if (!Number.isFinite(n) || n < 0) {
      return { error: "qty_affected must be >= 0" };
    }
    out.qty_affected = n;
  }
  if ("description" in body) {
    const v = typeof body.description === "string" ? body.description.trim() : "";
    if (!v) return { error: "description cannot be empty" };
    out.description = v;
  }
  if ("photo_urls" in body) {
    if (body.photo_urls === null) {
      out.photo_urls = null;
    } else {
      if (!Array.isArray(body.photo_urls)) {
        return { error: "photo_urls must be an array of strings" };
      }
      for (let i = 0; i < body.photo_urls.length; i++) {
        if (typeof body.photo_urls[i] !== "string" || !body.photo_urls[i].trim()) {
          return { error: `photo_urls[${i}] must be a non-empty string` };
        }
      }
      out.photo_urls = body.photo_urls.map((s) => s.trim());
    }
  }
  if ("resolution" in body) {
    out.resolution = body.resolution ? String(body.resolution).trim() : null;
  }

  return { data: out };
}

export function validateFindingDelete(body) {
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

// Re-export for handler-shared helpers.
export { isUuid };
