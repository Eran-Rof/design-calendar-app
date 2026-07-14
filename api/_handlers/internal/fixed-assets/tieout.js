// api/internal/fixed-assets/tieout
//
// GET — per-period reconciliation of the fixed-asset register against the
// mirror GL. For each accounting month it returns the register's computed
// depreciation vs the mirror GL's depreciation-expense (6319) and accumulated-
// depreciation (1590) activity, plus a category:
//   tie | register_ahead | gl_ahead | unmapped
//
// This is the controllership value while Xoro is the system of record: it
// answers "does our asset register agree with the depreciation Xoro already
// booked into the GL we mirror?" It posts nothing. Also returns the cutover
// gate state (fixed_asset_settings.posting_enabled).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const { data: rows, error } = await admin
    .from("v_fixed_asset_gl_tieout")
    .select("period_month, reg_depr_cents, reg_depr_mapped_cents, gl_expense_cents, gl_accum_cents, diff_cents, category")
    .eq("entity_id", entity.id)
    .order("period_month", { ascending: false })
    .limit(240);
  if (error) return res.status(500).json({ error: error.message });

  const { data: settings } = await admin
    .from("fixed_asset_settings")
    .select("posting_enabled")
    .eq("entity_id", entity.id)
    .maybeSingle();

  const list = rows || [];
  const totals = list.reduce(
    (t, r) => ({
      reg_depr_cents: t.reg_depr_cents + Number(r.reg_depr_cents || 0),
      gl_expense_cents: t.gl_expense_cents + Number(r.gl_expense_cents || 0),
      diff_cents: t.diff_cents + Number(r.diff_cents || 0),
    }),
    { reg_depr_cents: 0, gl_expense_cents: 0, diff_cents: 0 },
  );
  const counts = list.reduce((c, r) => { c[r.category] = (c[r.category] || 0) + 1; return c; }, {});

  return res.status(200).json({
    rows: list,
    totals,
    category_counts: counts,
    posting_enabled: !!(settings && settings.posting_enabled),
  });
}
