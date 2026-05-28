// api/internal/gl-periods/:id/preflight
//
// GET. Returns the rows from gl_period_close_preflight() for this period
// (one row per check, with check_name + status + detail + blocking).
//
// Used by the Periods panel "Run checks" button (P5-7). The close handler
// (P5-1) also calls this RPC internally and rejects 409 when any blocking
// row has status='fail' (unless ?ignore_warnings=true on close).
//
// Tangerine P5-7.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function summarize(rows) {
  const out = {
    total: rows.length,
    passed: 0,
    failed_blocking: 0,
    failed_warnings: 0,
    can_close: true,
  };
  for (const r of rows) {
    if (r.status === "pass") {
      out.passed += 1;
    } else if (r.blocking) {
      out.failed_blocking += 1;
      out.can_close = false;
    } else {
      out.failed_warnings += 1;
    }
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Resolve entity_id from the period (the RPC takes both).
  const { data: period, error: pErr } = await admin
    .from("gl_periods")
    .select("id, entity_id, fiscal_year, period_number, status, starts_on, ends_on")
    .eq("id", id)
    .maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: "Period not found" });

  const { data: rows, error: rpcErr } = await admin.rpc("gl_period_close_preflight", {
    p_entity_id: period.entity_id,
    p_period_id: id,
  });
  if (rpcErr) return res.status(500).json({ error: rpcErr.message });

  return res.status(200).json({
    period_id: id,
    period: {
      fiscal_year: period.fiscal_year,
      period_number: period.period_number,
      status: period.status,
      starts_on: period.starts_on,
      ends_on: period.ends_on,
    },
    rows: rows || [],
    summary: summarize(rows || []),
  });
}
