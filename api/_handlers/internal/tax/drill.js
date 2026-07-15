// api/internal/tax/drill
//
// M19 — the GL lines making up a jurisdiction-period liability, so the CEO can
// drill from any liability number to the underlying tax-payable account activity
// (each line links to GL detail via je_id).
//
//   GET /api/internal/tax/drill?jurisdiction=<code>
//        &from=YYYY-MM-DD&to=YYYY-MM-DD   (defaults: all-time)
//        &basis=ACCRUAL
//     → { jurisdiction, account_code, rows[], totals }
//   rows: { je_id, posting_date, description, memo, credit_cents (collected),
//           debit_cents (remitted), source_module, source_id }

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

  const url = new URL(req.url, `https://${req.headers.host}`);
  const jurisdiction = (url.searchParams.get("jurisdiction") || "").trim();
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const basis = (url.searchParams.get("basis") || "ACCRUAL").trim().toUpperCase();
  if (!jurisdiction) return res.status(400).json({ error: "jurisdiction (code) required" });

  const { data: jur } = await admin
    .from("tax_jurisdictions")
    .select("gl_account_id, gl_account_code, label")
    .eq("entity_id", entity.id)
    .eq("code", jurisdiction)
    .maybeSingle();
  if (!jur || !jur.gl_account_id) return res.status(404).json({ error: `Jurisdiction ${jurisdiction} not found or has no bound GL account` });

  let q = admin
    .from("v_gl_detail")
    .select("je_id, posting_date, description, memo, debit_cents, credit_cents, source_module, source_id, basis")
    .eq("entity_id", entity.id)
    .eq("account_id", jur.gl_account_id)
    .eq("basis", basis === "CASH" ? "CASH" : "ACCRUAL")
    .order("posting_date", { ascending: false })
    .limit(2000);
  if (from) q = q.gte("posting_date", from);
  if (to) q = q.lte("posting_date", to);
  const { data: rows, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const list = rows || [];
  const totals = list.reduce(
    (t, r) => ({
      collected_cents: t.collected_cents + Number(r.credit_cents || 0),
      remitted_cents: t.remitted_cents + Number(r.debit_cents || 0),
    }),
    { collected_cents: 0, remitted_cents: 0 },
  );
  totals.net_due_cents = totals.collected_cents - totals.remitted_cents;

  return res.status(200).json({
    jurisdiction,
    label: jur.label,
    account_code: jur.gl_account_code,
    rows: list,
    totals,
  });
}
