// api/internal/procurement/qc-findings
//
// Tangerine P13-5 — M26 QC findings list + create.
//
// GET   — list findings. Required: ?inspection_id=<uuid>
//          Optional: ?severity=<minor|major|critical>
//                    ?limit=N (default 200, max 500)
// POST  — create a new finding. Body:
//            {
//              inspection_id (uuid, required),
//              category (text, required),
//              severity (minor|major|critical, required),
//              qty_affected? (int >= 0, default 0),
//              description (text, required),
//              photo_urls? (text[]),    // M29 document URLs
//              resolution? (text)
//            }
//
// Notes:
//  - photo_urls are passed straight through to the text[] column; we
//    validate that each entry is a string.
//  - The handler does NOT auto-create a case here — that decision belongs
//    on the inspection status transition (see qc-inspections/[id].js).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVERITY_VALUES = ["minor", "major", "critical"];

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

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const params = Object.fromEntries(url.searchParams.entries());
    const v = parseListQuery(params);
    if (v.error) return res.status(400).json({ error: v.error });

    let query = admin
      .from("tanda_po_qc_findings")
      .select("*")
      .eq("inspection_id", v.data.inspection_id)
      .order("created_at")
      .limit(v.data.limit);
    if (v.data.severity) query = query.eq("severity", v.data.severity);

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
    const v = validateFindingInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Ensure parent inspection exists before inserting child.
    const { data: parent } = await admin
      .from("tanda_po_qc_inspections")
      .select("id")
      .eq("id", v.data.inspection_id)
      .maybeSingle();
    if (!parent) return res.status(404).json({ error: "Parent inspection not found" });

    const { data: inserted, error: insErr } = await admin
      .from("tanda_po_qc_findings")
      .insert({
        inspection_id: v.data.inspection_id,
        category: v.data.category,
        severity: v.data.severity,
        qty_affected: v.data.qty_affected,
        description: v.data.description,
        photo_urls: v.data.photo_urls,
        resolution: v.data.resolution,
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
  const inspection_id = (params.inspection_id || "").trim();
  const severity      = (params.severity || "").trim();

  let limit = parseInt(params.limit || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 500) limit = 500;

  if (!inspection_id) return { error: "inspection_id is required" };
  if (!UUID_RE.test(inspection_id)) return { error: "inspection_id must be a uuid" };
  if (severity && !SEVERITY_VALUES.includes(severity)) {
    return { error: `severity must be one of ${SEVERITY_VALUES.join(", ")}` };
  }

  return {
    data: {
      inspection_id,
      severity: severity || null,
      limit,
    },
  };
}

export function validateFindingInsert(body) {
  if (!body.inspection_id || !isUuid(body.inspection_id)) {
    return { error: "inspection_id (uuid) is required" };
  }
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!category) return { error: "category is required" };
  if (category.length > 200) return { error: "category must be ≤ 200 chars" };

  const severity = typeof body.severity === "string" ? body.severity.trim() : "";
  if (!SEVERITY_VALUES.includes(severity)) {
    return { error: `severity must be one of ${SEVERITY_VALUES.join(", ")}` };
  }

  let qty_affected = 0;
  if (body.qty_affected !== undefined && body.qty_affected !== null && body.qty_affected !== "") {
    qty_affected = parseInt(body.qty_affected, 10);
    if (!Number.isFinite(qty_affected) || qty_affected < 0) {
      return { error: "qty_affected must be >= 0" };
    }
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) return { error: "description is required" };

  let photo_urls = null;
  if (body.photo_urls !== undefined && body.photo_urls !== null) {
    if (!Array.isArray(body.photo_urls)) {
      return { error: "photo_urls must be an array of strings" };
    }
    for (let i = 0; i < body.photo_urls.length; i++) {
      if (typeof body.photo_urls[i] !== "string" || !body.photo_urls[i].trim()) {
        return { error: `photo_urls[${i}] must be a non-empty string` };
      }
    }
    photo_urls = body.photo_urls.map((s) => s.trim());
  }

  return {
    data: {
      inspection_id: body.inspection_id,
      category,
      severity,
      qty_affected,
      description,
      photo_urls,
      resolution: body.resolution ? String(body.resolution).trim() : null,
    },
  };
}
