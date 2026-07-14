// api/internal/fixed-assets  (h623)
//
// P25 / M21 — fixed-asset register list + create.
//
//   GET  /api/internal/fixed-assets               → list (+ monthly_depreciation)
//   POST /api/internal/fixed-assets               → create (assigns FA-NNNN)
//        body { name, category?, acquisition_date, acquisition_cost_cents,
//               salvage_value_cents?, useful_life_months, depreciation_start?,
//               asset_account_id?, accum_deprec_account_id?, deprec_expense_account_id?, notes? }

import { createClient } from "@supabase/supabase-js";
import { monthlyAmount } from "../../../_lib/fixed-assets/depreciation.js";

export const config = { maxDuration: 15 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function nextCode(admin, entityId) {
  const { data } = await admin.from("fixed_assets").select("asset_code").eq("entity_id", entityId).like("asset_code", "FA-%").order("asset_code", { ascending: false }).limit(1);
  let n = 1;
  if (data && data[0] && data[0].asset_code) { const p = parseInt(String(data[0].asset_code).slice(3), 10); if (Number.isFinite(p)) n = p + 1; }
  return `FA-${String(n).padStart(4, "0")}`;
}
const METHODS = new Set(["straight_line", "declining_balance_200", "declining_balance_150", "units_of_production"]);
const EDIT = ["name", "description", "category", "acquisition_date", "acquisition_cost_cents", "salvage_value_cents", "useful_life_months", "method", "in_service_date", "depreciation_start", "units_total", "asset_account_id", "accum_deprec_account_id", "deprec_expense_account_id", "notes"];

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin.from("fixed_assets").select("*").order("acquisition_date", { ascending: false }).limit(1000);
    if (error) return res.status(500).json({ error: error.message });
    const assets = (data || []).map((a) => ({ ...a, monthly_depreciation_cents: monthlyAmount(a) }));
    return res.status(200).json({ assets });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};

  if (req.method === "POST") {
    if (!body.name) return res.status(400).json({ error: "name required" });
    if (!body.acquisition_date) return res.status(400).json({ error: "acquisition_date required" });
    if (!(Number(body.useful_life_months) > 0)) return res.status(400).json({ error: "useful_life_months must be > 0" });
    const method = body.method && METHODS.has(body.method) ? body.method : "straight_line";
    if (body.method && !METHODS.has(body.method)) return res.status(400).json({ error: `method must be one of ${[...METHODS].join(", ")}` });
    if (method === "units_of_production" && !(Number(body.units_total) > 0)) return res.status(400).json({ error: "units_total (> 0) is required for units_of_production" });
    const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
    const inService = body.in_service_date || body.depreciation_start || body.acquisition_date;
    const row = {
      entity_id: entity.id, asset_code: await nextCode(admin, entity.id),
      name: body.name, description: body.description || null, category: body.category || null, acquisition_date: body.acquisition_date,
      acquisition_cost_cents: Math.round(Number(body.acquisition_cost_cents) || 0),
      salvage_value_cents: Math.round(Number(body.salvage_value_cents) || 0),
      useful_life_months: Math.round(Number(body.useful_life_months)),
      method, in_service_date: inService, depreciation_start: inService,
      units_total: method === "units_of_production" ? Math.round(Number(body.units_total)) : null,
      asset_account_id: body.asset_account_id || null, accum_deprec_account_id: body.accum_deprec_account_id || null,
      deprec_expense_account_id: body.deprec_expense_account_id || null,
      notes: body.notes || null, created_by_user_id: body.created_by_user_id || null,
    };
    const { data, error } = await admin.from("fixed_assets").insert(row).select("id, asset_code").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id: data.id, asset_code: data.asset_code, message: `Asset ${data.asset_code} created.` });
  }

  if (req.method === "PATCH") {
    if (!body.id) return res.status(400).json({ error: "id required" });
    const patch = { updated_at: new Date().toISOString() };
    for (const f of EDIT) if (body[f] !== undefined) patch[f] = body[f] === "" ? null : body[f];
    const { error } = await admin.from("fixed_assets").update(patch).eq("id", body.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
