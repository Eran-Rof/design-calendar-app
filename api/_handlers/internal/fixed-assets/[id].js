// api/internal/fixed-assets/:id  (h624)
//
// P25 / M21 — depreciate / dispose / delete a fixed asset.
//
//   GET    /api/internal/fixed-assets/:id          → asset + depreciation history
//   POST   /api/internal/fixed-assets/:id          → run depreciation or dispose
//        body { action: 'depreciate', through_date: 'YYYY-MM-DD' }   (records the
//              schedule rows + updates accumulated; GL posting deferred)
//        body { action: 'dispose', disposed_date, disposal_proceeds_cents? }
//   DELETE /api/internal/fixed-assets/:id          → delete (no depreciation yet)

import { createClient } from "@supabase/supabase-js";
import { straightLineSchedule } from "../../../_lib/fixed-assets/depreciation.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: asset } = await admin.from("fixed_assets").select("*").eq("id", id).maybeSingle();
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  if (req.method === "GET") {
    const { data: hist } = await admin.from("fixed_asset_depreciation").select("*").eq("fixed_asset_id", id).order("period_date", { ascending: true });
    return res.status(200).json({ asset, depreciation: hist || [] });
  }

  if (req.method === "DELETE") {
    if (Number(asset.accumulated_depreciation_cents) > 0) return res.status(409).json({ error: "Cannot delete an asset that has depreciation recorded" });
    const { error } = await admin.from("fixed_assets").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    if (body.action === "depreciate") {
      if (asset.status !== "active") return res.status(409).json({ error: `Asset is '${asset.status}', not active` });
      const through = body.through_date || new Date().toISOString().slice(0, 10);
      const { data: existing } = await admin.from("fixed_asset_depreciation").select("period_date").eq("fixed_asset_id", id);
      const recorded = (existing || []).map((r) => r.period_date);
      const { periods, total_cents } = straightLineSchedule(asset, through, recorded, Number(asset.accumulated_depreciation_cents) || 0);
      if (periods.length === 0) return res.status(200).json({ ok: true, recorded: 0, message: "Nothing to depreciate through that date." });
      const rows = periods.map((p) => ({ fixed_asset_id: id, period_date: p.period_date, amount_cents: p.amount_cents }));
      const { error: iErr } = await admin.from("fixed_asset_depreciation").insert(rows);
      if (iErr) return res.status(500).json({ error: iErr.message });
      const newAccum = (Number(asset.accumulated_depreciation_cents) || 0) + total_cents;
      const base = (Number(asset.acquisition_cost_cents) || 0) - (Number(asset.salvage_value_cents) || 0);
      const status = newAccum >= base ? "fully_depreciated" : "active";
      await admin.from("fixed_assets").update({ accumulated_depreciation_cents: newAccum, status, updated_at: new Date().toISOString() }).eq("id", id);
      return res.status(200).json({ ok: true, recorded: periods.length, depreciation_cents: total_cents, accumulated_depreciation_cents: newAccum, status, message: `Recorded ${periods.length} period(s), $${(total_cents / 100).toFixed(2)}. (GL posting is deferred.)` });
    }

    if (body.action === "dispose") {
      if (asset.status === "disposed") return res.status(409).json({ error: "Already disposed" });
      const patch = { status: "disposed", disposed_date: body.disposed_date || new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() };
      if (body.disposal_proceeds_cents !== undefined) patch.disposal_proceeds_cents = Math.round(Number(body.disposal_proceeds_cents) || 0);
      const { error } = await admin.from("fixed_assets").update(patch).eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, message: "Asset disposed. (Gain/loss GL posting deferred.)" });
    }

    return res.status(400).json({ error: "Unknown action (depreciate | dispose)" });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
