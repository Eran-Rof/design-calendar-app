// api/internal/budgets  (h625)
//
// P25 / M22 — GL budgets + budget-vs-actual.
//
//   GET  /api/internal/budgets?fiscal_year=YYYY   → budgets (+ account + actual)
//   POST /api/internal/budgets                    → upsert one budget cell
//        body { gl_account_id, fiscal_year, period_number?, amount_cents, notes? }
//   DELETE /api/internal/budgets?id=<uuid>        → remove a budget cell

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const fy = parseInt(url.searchParams.get("fiscal_year") || "0", 10);
    let q = admin.from("gl_budgets").select("*, gl_accounts(code, name, account_type)").eq("entity_id", entity.id);
    if (fy) q = q.eq("fiscal_year", fy);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    // Best-effort actuals from the balance view (full-year, by account).
    const actualByAccount = new Map();
    try {
      const ids = [...new Set((data || []).map((b) => b.gl_account_id))];
      if (ids.length) {
        const { data: bals } = await admin.from("vw_gl_account_balances").select("account_id, balance_cents").in("account_id", ids);
        for (const b of bals || []) actualByAccount.set(b.account_id, Number(b.balance_cents) || 0);
      }
    } catch { /* view may not exist — actuals stay null */ }
    const budgets = (data || []).map((b) => ({
      id: b.id, gl_account_id: b.gl_account_id,
      account_code: b.gl_accounts?.code || null, account_name: b.gl_accounts?.name || null, account_type: b.gl_accounts?.account_type || null,
      fiscal_year: b.fiscal_year, period_number: b.period_number, amount_cents: b.amount_cents,
      actual_cents: actualByAccount.has(b.gl_account_id) ? actualByAccount.get(b.gl_account_id) : null, notes: b.notes,
    }));
    return res.status(200).json({ budgets });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    if (!body.gl_account_id) return res.status(400).json({ error: "gl_account_id required" });
    if (!(Number(body.fiscal_year) > 0)) return res.status(400).json({ error: "fiscal_year required" });
    const row = {
      entity_id: entity.id, gl_account_id: body.gl_account_id,
      fiscal_year: Math.round(Number(body.fiscal_year)), period_number: Math.round(Number(body.period_number) || 0),
      amount_cents: Math.round(Number(body.amount_cents) || 0), notes: body.notes || null, updated_at: new Date().toISOString(),
    };
    const { data, error } = await admin.from("gl_budgets")
      .upsert(row, { onConflict: "entity_id,gl_account_id,fiscal_year,period_number" }).select("id").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ id: data.id, message: "Budget saved." });
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const id = url.searchParams.get("id");
    if (!id) return res.status(400).json({ error: "id required" });
    const { error } = await admin.from("gl_budgets").delete().eq("id", id).eq("entity_id", entity.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
