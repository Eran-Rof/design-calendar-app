// api/internal/fixed-assets/generate-schedule
//
// POST { id, units? } — deterministically (re)build the full-life depreciation
// SCHEDULE for one asset into fixed_asset_depreciation. Idempotent: replaces
// all non-posted rows for the asset; posted rows (only exist post-cutover) are
// preserved and their periods skipped. NO GL POSTING — Tangerine's GL mirrors
// Xoro, which already books depreciation. This only records the register-side
// schedule (period, depreciation, accumulated, book value) for reconciliation.
//
//   units: optional array of per-period unit counts (units_of_production only).

import { createClient } from "@supabase/supabase-js";
import { buildSchedule } from "../../../_lib/fixed-assets/depreciation.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const id = body.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });

  const { data: asset } = await admin.from("fixed_assets").select("*").eq("id", id).maybeSingle();
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  const units = Array.isArray(body.units) ? body.units.map((n) => Number(n) || 0) : undefined;
  const schedule = buildSchedule(asset, units);
  if (schedule.length === 0) {
    return res.status(200).json({ ok: true, recorded: 0, message: asset.method === "units_of_production" && !units ? "units_of_production requires a per-period usage series." : "Nothing to schedule (check cost, life, and in-service date)." });
  }

  // Preserve posted periods (post-cutover only); replace everything else.
  const { data: posted } = await admin.from("fixed_asset_depreciation").select("period_date").eq("fixed_asset_id", id).eq("posted", true);
  const postedSet = new Set((posted || []).map((r) => r.period_date));

  const { error: dErr } = await admin.from("fixed_asset_depreciation").delete().eq("fixed_asset_id", id).eq("posted", false);
  if (dErr) return res.status(500).json({ error: dErr.message });

  const rows = schedule
    .filter((p) => !postedSet.has(p.period_date))
    .map((p) => ({
      fixed_asset_id: id,
      period_date: p.period_date,
      amount_cents: p.depreciation_cents,
      accumulated_cents: p.accumulated_cents,
      book_value_cents: p.book_value_cents,
      posted: false,
      source: "schedule",
    }));
  if (rows.length > 0) {
    const { error: iErr } = await admin.from("fixed_asset_depreciation").insert(rows);
    if (iErr) return res.status(500).json({ error: iErr.message });
  }

  // Register accumulated = accumulated through the current month-end.
  const today = new Date().toISOString().slice(0, 10);
  const throughRows = schedule.filter((p) => p.period_date <= today);
  const accumToDate = throughRows.length ? throughRows[throughRows.length - 1].accumulated_cents : 0;
  const base = Math.max(0, (Number(asset.acquisition_cost_cents) || 0) - (Number(asset.salvage_value_cents) || 0));
  const fullAccum = schedule[schedule.length - 1].accumulated_cents;
  const status = asset.status === "disposed" ? "disposed" : (accumToDate >= base && base > 0 ? "fully_depreciated" : "active");
  await admin.from("fixed_assets").update({ accumulated_depreciation_cents: accumToDate, status, updated_at: new Date().toISOString() }).eq("id", id);

  return res.status(200).json({
    ok: true,
    recorded: rows.length,
    periods: schedule.length,
    method: asset.method,
    accumulated_to_date_cents: accumToDate,
    lifetime_depreciation_cents: fullAccum,
    status,
    message: `Rebuilt ${schedule.length}-period ${String(asset.method).replace(/_/g, " ")} schedule. (Register only — no GL posted.)`,
  });
}
