// api/internal/xoro-mirror/ap
//
// Tangerine T10-3 — Manual trigger for the AP shadow-mirror.
//
// POST. Body: { mirror_date: 'YYYY-MM-DD' }
// Looks up the default entity (ROF), invokes mirrorApForDate, persists a
// `xoro_mirror_runs` row (domain='ap') with row counts + errors, and
// returns the summary to the caller.
//
// This endpoint will be invoked by:
//   - the Wave-C nightly cron (cron/xoro-mirror-nightly)
//   - the Wave-D admin "🔁 Shadow Mirror Status" panel — manual re-run
//
// Architecture: docs/tangerine/T10-shadow-mirror-architecture.md §4.2, §6.

import { createClient } from "@supabase/supabase-js";
import { mirrorApForDate } from "../../../_lib/xoro-mirror/ap.js";

export const config = { maxDuration: 60 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntity(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export function validateBody(body) {
  const b = body && typeof body === "object" ? body : {};
  if (!b.mirror_date) return { error: "mirror_date is required" };
  if (typeof b.mirror_date !== "string" || !ISO_DATE_RE.test(b.mirror_date)) {
    return { error: "mirror_date must be YYYY-MM-DD" };
  }
  return { data: { mirror_date: b.mirror_date } };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { body = {}; }
  }

  const v = validateBody(body);
  if (v.error) return res.status(400).json({ error: v.error });
  const { mirror_date } = v.data;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  let summary;
  try {
    summary = await mirrorApForDate(admin, entity.id, mirror_date);
  } catch (err) {
    return res.status(500).json({ error: `mirrorApForDate threw: ${err?.message || String(err)}` });
  }

  // Persist a xoro_mirror_runs audit row. We don't gate the response on
  // this insert succeeding — the mirror already happened, the audit is
  // best-effort.
  try {
    await admin.from("xoro_mirror_runs").insert({
      entity_id: entity.id,
      domain: "ap",
      mirror_date,
      rows_upserted: summary.rows_upserted,
      rows_unchanged: summary.rows_unchanged,
      rows_deleted: 0,
      errors: summary.errors || [],
    });
  } catch (err) {
    // Surface to client but don't 500 — the mirror itself succeeded.
    summary.errors = (summary.errors || []).concat([
      { po_number: null, reason: `xoro_mirror_runs insert threw: ${err?.message || String(err)}` },
    ]);
  }

  return res.status(200).json({
    ok: true,
    domain: "ap",
    mirror_date,
    entity_id: entity.id,
    ...summary,
  });
}
