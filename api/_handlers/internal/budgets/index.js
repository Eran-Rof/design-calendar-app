// api/internal/budgets
//
// Tangerine FP&A — GL budgets + budget-vs-actual (mig 20261030000000).
//
//   GET  /api/internal/budgets?fiscal_year=YYYY&scenario=default&basis=ACCRUAL
//        → { fiscal_year, scenario, basis, scenarios[], budgets[], variance[] }
//          budgets[]  = raw gl_budgets cells (for the entry grid), account meta.
//          variance[] = budget_vs_actual() rows (per account × month) for the
//                       variance dashboard + statement-style roll-ups.
//          scenarios[] = distinct scenario labels present for the year.
//
//   POST /api/internal/budgets
//        • single cell : { gl_account_id, fiscal_year, period_number?, amount_cents, scenario?, notes? }
//        • batch import : { fiscal_year, scenario?, rows: [{ gl_account_id, period_number?, amount_cents, notes? }] }
//        • seed         : { action:'seed', source_year, target_year, growth_pct?, grain?, basis, scenario? }
//
//   DELETE /api/internal/budgets?id=<uuid>                      → remove one cell
//   DELETE /api/internal/budgets?fiscal_year=YYYY&scenario=x&all=1 → clear a scenario/year
//
// Budget is PLANNING data only — nothing here ever posts to the GL.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
const VALID_BASIS = new Set(["ACCRUAL", "CASH"]);
function normScenario(v) { const s = (v == null ? "" : String(v)).trim(); return s || "default"; }
function normBasis(v) { const b = (v == null ? "" : String(v)).trim().toUpperCase(); return VALID_BASIS.has(b) ? b : "ACCRUAL"; }

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const fy = parseInt(url.searchParams.get("fiscal_year") || "0", 10);
    const scenario = normScenario(url.searchParams.get("scenario"));
    const basis = normBasis(url.searchParams.get("basis"));

    // Raw budget cells (for the entry grid) + account meta.
    let q = admin
      .from("gl_budgets")
      .select("id, gl_account_id, fiscal_year, period_number, amount_cents, scenario, notes, gl_accounts(code, name, account_type, account_subtype)")
      .eq("entity_id", entity.id)
      .eq("scenario", scenario);
    if (fy) q = q.eq("fiscal_year", fy);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const budgets = (data || []).map((b) => ({
      id: b.id, gl_account_id: b.gl_account_id,
      account_code: b.gl_accounts?.code || null, account_name: b.gl_accounts?.name || null,
      account_type: b.gl_accounts?.account_type || null, account_subtype: b.gl_accounts?.account_subtype || null,
      fiscal_year: b.fiscal_year, period_number: b.period_number, amount_cents: Number(b.amount_cents) || 0,
      scenario: b.scenario, notes: b.notes,
    }));

    // Distinct scenarios present for the year (for the scenario selector).
    let scenarios = ["default"];
    try {
      let sq = admin.from("gl_budgets").select("scenario").eq("entity_id", entity.id);
      if (fy) sq = sq.eq("fiscal_year", fy);
      const { data: sc } = await sq;
      const set = new Set(["default"]);
      for (const r of sc || []) if (r.scenario) set.add(r.scenario);
      scenarios = [...set].sort();
    } catch { /* keep default */ }

    // Budget-vs-actual grid (per account × month).
    let variance = [];
    if (fy) {
      try {
        const { data: v, error: ve } = await admin.rpc("budget_vs_actual", {
          p_entity_id: entity.id, p_basis: basis, p_fiscal_year: fy, p_scenario: scenario,
        });
        if (!ve) variance = (v || []).map((r) => ({
          account_id: r.account_id, code: r.code, name: r.name,
          account_type: r.account_type, account_subtype: r.account_subtype,
          parent_code: r.parent_code, parent_name: r.parent_name,
          month: r.month, budget_cents: Number(r.budget_cents) || 0, actual_cents: Number(r.actual_cents) || 0,
          variance_cents: Number(r.variance_cents) || 0, favorable: r.favorable,
          variance_pct: r.variance_pct == null ? null : Number(r.variance_pct),
        }));
      } catch { /* variance stays empty */ }
    }

    return res.status(200).json({ fiscal_year: fy || null, scenario, basis, scenarios, budgets, variance });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    // Seed-from-actuals.
    if (body.action === "seed") {
      const src = Math.round(Number(body.source_year));
      const tgt = Math.round(Number(body.target_year));
      if (!(src > 0) || !(tgt > 0)) return res.status(400).json({ error: "source_year and target_year required" });
      const grain = body.grain === "monthly" ? "monthly" : "annual";
      const basis = normBasis(body.basis);
      const scenario = normScenario(body.scenario);
      const growth = Number(body.growth_pct) || 0;
      const { data, error } = await admin.rpc("seed_budget_from_actuals", {
        p_entity_id: entity.id, p_basis: basis, p_source_year: src, p_target_year: tgt,
        p_growth_pct: growth, p_scenario: scenario, p_grain: grain,
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ seeded: Number(data) || 0, message: `Seeded ${Number(data) || 0} budget rows from ${src} actuals.` });
    }

    // Batch import (CSV / paste).
    if (Array.isArray(body.rows)) {
      const fy = Math.round(Number(body.fiscal_year));
      if (!(fy > 0)) return res.status(400).json({ error: "fiscal_year required for a batch import" });
      const scenario = normScenario(body.scenario);
      const rows = [];
      for (const r of body.rows) {
        if (!r || !r.gl_account_id) continue;
        const period = Math.round(Number(r.period_number) || 0);
        if (period < 0 || period > 12) return res.status(400).json({ error: `period_number out of range (0-12): ${period}` });
        rows.push({
          entity_id: entity.id, gl_account_id: r.gl_account_id, fiscal_year: fy,
          period_number: period, amount_cents: Math.round(Number(r.amount_cents) || 0),
          scenario, notes: r.notes || null, updated_at: new Date().toISOString(),
        });
      }
      if (rows.length === 0) return res.status(400).json({ error: "No valid rows to import" });
      const { error } = await admin.from("gl_budgets")
        .upsert(rows, { onConflict: "entity_id,gl_account_id,fiscal_year,period_number,scenario" });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ imported: rows.length, message: `Imported ${rows.length} budget rows.` });
    }

    // Single cell.
    if (!body.gl_account_id) return res.status(400).json({ error: "gl_account_id required" });
    if (!(Number(body.fiscal_year) > 0)) return res.status(400).json({ error: "fiscal_year required" });
    const period = Math.round(Number(body.period_number) || 0);
    if (period < 0 || period > 12) return res.status(400).json({ error: "period_number must be 0-12" });
    const row = {
      entity_id: entity.id, gl_account_id: body.gl_account_id,
      fiscal_year: Math.round(Number(body.fiscal_year)), period_number: period,
      amount_cents: Math.round(Number(body.amount_cents) || 0), scenario: normScenario(body.scenario),
      notes: body.notes || null, updated_at: new Date().toISOString(),
    };
    const { data, error } = await admin.from("gl_budgets")
      .upsert(row, { onConflict: "entity_id,gl_account_id,fiscal_year,period_number,scenario" }).select("id").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ id: data.id, message: "Budget saved." });
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const id = url.searchParams.get("id");
    if (id) {
      const { error } = await admin.from("gl_budgets").delete().eq("id", id).eq("entity_id", entity.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }
    // Clear a whole scenario/year (guarded by all=1).
    const fy = parseInt(url.searchParams.get("fiscal_year") || "0", 10);
    if (url.searchParams.get("all") === "1" && fy) {
      const scenario = normScenario(url.searchParams.get("scenario"));
      const { error } = await admin.from("gl_budgets").delete()
        .eq("entity_id", entity.id).eq("fiscal_year", fy).eq("scenario", scenario);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, cleared: `${scenario}/${fy}` });
    }
    return res.status(400).json({ error: "id required (or fiscal_year + scenario + all=1)" });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
