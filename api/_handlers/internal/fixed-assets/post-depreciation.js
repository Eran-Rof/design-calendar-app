// api/internal/fixed-assets/post-depreciation
//
// POST { period: 'YYYY-MM', reason } — post the monthly depreciation journal
// entry (DR Depreciation Expense / CR Accumulated Depreciation) for every
// unposted schedule row in that period, then flag the rows posted.
//
// ⚠️ CUTOVER GATE — this is GATED OFF by default. It refuses unless
// fixed_asset_settings.posting_enabled = TRUE. It MUST stay off while Xoro is
// the system of record: Tangerine's GL is a faithful 1:1 mirror of Xoro
// (journal_type 'xoro_gl_mirror'), and Xoro ALREADY posts depreciation into the
// GL we mirror. Turning this on before Xoro cutover would DOUBLE-COUNT
// depreciation. It exists so that at cutover — when Tangerine becomes the
// system of record — depreciation can be booked natively by flipping the flag.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 25 };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function monthEndISO(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
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
  const period = String(body.period || "").trim();
  if (!MONTH_RE.test(period)) return res.status(400).json({ error: "period must be YYYY-MM" });

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // ── THE GATE ────────────────────────────────────────────────────────────
  const { data: settings } = await admin.from("fixed_asset_settings").select("posting_enabled").eq("entity_id", entity.id).maybeSingle();
  if (!settings || !settings.posting_enabled) {
    return res.status(409).json({
      error: "Depreciation GL posting is disabled (cutover gate). Tangerine's GL mirrors Xoro, which already books depreciation — posting here now would double-count. Enable fixed_asset_settings.posting_enabled only at Xoro cutover.",
      gated: true,
    });
  }

  const reason = String(body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason is required (audit trail / T11)" });

  const periodEnd = monthEndISO(period);
  // Unposted schedule rows in this month, with the asset's GL account mappings.
  const { data: due } = await admin
    .from("fixed_asset_depreciation")
    .select("id, amount_cents, fixed_asset_id, fixed_assets!inner(entity_id, deprec_expense_account_id, accum_deprec_account_id)")
    .eq("period_date", periodEnd)
    .eq("posted", false);
  const list = (due || []).filter((r) => r.fixed_assets && r.fixed_assets.entity_id === entity.id && Number(r.amount_cents) > 0);
  if (list.length === 0) return res.status(200).json({ ok: true, posted: 0, message: `No unposted depreciation for ${period}.` });

  // Resolve default accounts (6319 expense / 1590 accum) for unmapped assets.
  const { data: defAccts } = await admin.from("gl_accounts").select("id, code").eq("entity_id", entity.id).in("code", ["6319", "1590"]);
  const byCode = Object.fromEntries((defAccts || []).map((a) => [a.code, a.id]));
  const expDefault = byCode["6319"], accumDefault = byCode["1590"];

  // Aggregate per (expense_acct, accum_acct) pair.
  const pairs = new Map();
  for (const r of list) {
    const exp = r.fixed_assets.deprec_expense_account_id || expDefault;
    const accum = r.fixed_assets.accum_deprec_account_id || accumDefault;
    if (!exp || !accum) return res.status(422).json({ error: "Cannot resolve depreciation-expense (6319) or accumulated-depreciation (1590) GL account." });
    const key = `${exp}|${accum}`;
    pairs.set(key, (pairs.get(key) || 0) + Number(r.amount_cents));
  }

  const lines = [];
  let ln = 1;
  for (const [key, cents] of pairs) {
    const [exp, accum] = key.split("|");
    const dollars = (cents / 100).toFixed(2);
    lines.push({ line_number: ln++, account_id: exp, debit: dollars, credit: "0", memo: `Depreciation ${period}` });
    lines.push({ line_number: ln++, account_id: accum, debit: "0", credit: dollars, memo: `Accumulated depreciation ${period}` });
  }

  const { data: jeId, error: postErr } = await admin.rpc("gl_post_journal_entry", {
    payload: {
      entity_id: entity.id,
      basis: "ACCRUAL",
      journal_type: "fixed_asset_depreciation",
      posting_date: periodEnd,
      source_module: "fixed_assets",
      source_table: "fixed_asset_depreciation",
      source_id: period,
      description: `Fixed-asset depreciation ${period}`,
      audit_reason: reason,
      created_by_user_id: body.created_by_user_id || null,
      lines,
    },
  });
  if (postErr) return res.status(500).json({ error: postErr.message });

  const ids = list.map((r) => r.id);
  await admin.from("fixed_asset_depreciation").update({ posted: true, posted_je_id: jeId, source: "posted" }).in("id", ids);

  return res.status(200).json({ ok: true, posted: ids.length, journal_entry_id: jeId, message: `Posted depreciation JE for ${period} (${ids.length} row(s)).` });
}
