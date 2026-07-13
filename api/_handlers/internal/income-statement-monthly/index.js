// api/internal/income-statement-monthly
//
// Tangerine P5-3 / M6 — per-account, per-MONTH Income Statement rows for the
// best-in-class P&L panel (monthly-column "spreadsheet" view + parent group
// headers). Sibling of /api/internal/income-statement; that endpoint returns one
// row per account for the whole range, this one returns one row per
// (account, year, month) plus the parent-group hierarchy so the panel can pivot
// months into columns and render group headers with indented sub-accounts.
//
// GET query params:
//   basis=ACCRUAL|CASH   (required)
//   from=YYYY-MM-DD       (optional; defaults to FY start = Jan 1 of current year)
//   to=YYYY-MM-DD         (optional; defaults to today)
//
// Calls the income_statement_monthly(entity, basis, from, to) RPC (mig
// 20260983000000). Returns:
//   { basis, from, to, rows: [
//       { entity_id, basis, year, month, account_id, account_type,
//         account_subtype, code, name, parent_code, parent_name, amount_cents }
//   ] }
// Rows sorted by code, then year, then month.

import { createClient } from "@supabase/supabase-js";
import { resolveReportEntityId, validateQuery } from "../income-statement/index.js";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Panels always send from/to (they have date pickers); this is only a safety
// net matching the sibling endpoint: current calendar year → today.
function defaultRange() {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  return { from: `${today.getUTCFullYear()}-01-01`, to: todayISO };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveReportEntityId(admin, req);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = validateQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  let { basis, from, to } = v.data;
  if (!from || !to) {
    const dflt = defaultRange();
    if (!from) from = dflt.from;
    if (!to) to = dflt.to;
  }

  try {
    const { data, error } = await admin.rpc("income_statement_monthly", {
      p_entity_id: entityId,
      p_basis: basis,
      p_from_date: from,
      p_to_date: to,
    });
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data || []).slice().sort((a, b) => {
      const ca = a.code || "", cb = b.code || "";
      if (ca !== cb) return ca < cb ? -1 : 1;
      if ((a.year || 0) !== (b.year || 0)) return (a.year || 0) - (b.year || 0);
      return (a.month || 0) - (b.month || 0);
    });

    return res.status(200).json({ basis, from, to, rows });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
