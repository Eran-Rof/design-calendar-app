// api/_handlers/internal/recon/run-ar.js
//
// Tangerine P9-3 — Manual trigger for the AR reconciliation engine.
//
// POST /api/internal/recon/run-ar
// Body: { period_start, period_end, replay_of_id? }
//   - period_start  required, ISO YYYY-MM-DD (inclusive)
//   - period_end    required, ISO YYYY-MM-DD (inclusive)
//   - replay_of_id  optional uuid; when present cadence='replay' (D11)
//                   and the run is recorded pointing back to the original.
//
// entity_id is resolved server-side via the X-Entity-ID header so we
// don't trust client-supplied entity uuids on this admin surface.
//
// Cadence:
//   - replay_of_id present → 'replay'
//   - otherwise            → 'manual'
//
// (Weekly cadence is reserved for the future P9-2/P9-3 sibling cron
// jobs — manual triggers are always 'manual' or 'replay' per arch §3.2.)
//
// Delegates to runArReconciliation from api/_lib/recon/ar-engine.js.

import { createClient } from "@supabase/supabase-js";
import { runArReconciliation } from "../../../_lib/recon/ar-engine.js";

export const config = { maxDuration: 300 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Entity-ID",
  );
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

function pickHeader(req, name) {
  const h = req?.headers;
  if (!h) return null;
  const lower = name.toLowerCase();
  if (typeof h.get === "function") return h.get(name) || h.get(lower) || null;
  return h[name] || h[lower] || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse body
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }
  const period_start = body?.period_start;
  const period_end = body?.period_end;
  const replay_of_id = body?.replay_of_id ?? null;

  // Validate inputs early — same checks as the engine but at the API
  // boundary so we can return 400 (not 500) for client errors.
  if (typeof period_start !== "string" || !ISO_DATE_RE.test(period_start)) {
    return res.status(400).json({ error: "period_start (YYYY-MM-DD) is required" });
  }
  if (typeof period_end !== "string" || !ISO_DATE_RE.test(period_end)) {
    return res.status(400).json({ error: "period_end (YYYY-MM-DD) is required" });
  }
  if (period_end < period_start) {
    return res.status(400).json({ error: "period_end is before period_start" });
  }
  if (replay_of_id !== null) {
    if (typeof replay_of_id !== "string" || !UUID_RE.test(replay_of_id)) {
      return res.status(400).json({ error: "replay_of_id must be a uuid" });
    }
  }

  // Resolve entity_id from the X-Entity-ID header (admin surface).
  const entity_id = pickHeader(req, "X-Entity-ID");
  if (!entity_id || typeof entity_id !== "string" || !UUID_RE.test(entity_id)) {
    return res.status(400).json({ error: "X-Entity-ID header (uuid) is required" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const cadence = replay_of_id ? "replay" : "manual";

  try {
    const out = await runArReconciliation({
      admin,
      entity_id,
      period_start,
      period_end,
      cadence,
      replay_of_id,
    });
    if (!out.ok) {
      return res.status(500).json({
        ok: false,
        recon_run_id: out.recon_run_id,
        status: out.status,
        errors: out.errors,
      });
    }
    return res.status(200).json({
      ok: true,
      recon_run_id: out.recon_run_id,
      status: out.status,
      cadence,
      summary: out.summary,
      errors: out.errors,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e instanceof Error ? e.message : String(e) });
  }
}
