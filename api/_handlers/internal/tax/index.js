// api/internal/tax
//
// M19 — Sales-Tax / VAT liability by jurisdiction, READ from the GL tax-payable
// accounts (Xoro is system of record; this module posts nothing).
//
//   GET /api/internal/tax
//        ?jurisdiction=<code>   filter monthly rows to one jurisdiction
//        &from=YYYY-MM-DD&to=YYYY-MM-DD   restrict monthly rows to a period range
//        &basis=ACCRUAL         (books basis; all tax activity is ACCRUAL)
//     → { jurisdictions[], summary[], monthly[], basis }
//
// summary = current liability per jurisdiction (v_tax_liability_summary).
// monthly = per jurisdiction × month collected/remitted/net + running liability.

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

  const { data: jurisdictions, error: jErr } = await admin
    .from("tax_jurisdictions")
    .select("id, code, label, country_region, flag, gl_account_code, filing_frequency, grace_days, is_clearing, sort_order, notes, status")
    .eq("entity_id", entity.id)
    .eq("status", "active")
    .order("sort_order", { ascending: true });
  if (jErr) return res.status(500).json({ error: jErr.message });

  const { data: summary, error: sErr } = await admin
    .from("v_tax_liability_summary")
    .select("jurisdiction_id, jurisdiction_code, jurisdiction_label, country_region, flag, gl_account_code, filing_frequency, grace_days, is_clearing, sort_order, collected_cents, remitted_cents, net_due_cents, last_activity_date")
    .eq("entity_id", entity.id)
    .order("sort_order", { ascending: true });
  if (sErr) return res.status(500).json({ error: sErr.message });

  let mq = admin
    .from("v_tax_liability_by_jurisdiction")
    .select("jurisdiction_id, jurisdiction_code, jurisdiction_label, flag, gl_account_code, period_month, collected_cents, remitted_cents, net_cents, running_liability_cents, is_clearing")
    .eq("entity_id", entity.id)
    .order("jurisdiction_code", { ascending: true })
    .order("period_month", { ascending: true })
    .limit(5000);
  if (jurisdiction) mq = mq.eq("jurisdiction_code", jurisdiction);
  if (from) mq = mq.gte("period_month", from);
  if (to) mq = mq.lte("period_month", to);
  const { data: monthly, error: mErr } = await mq;
  if (mErr) return res.status(500).json({ error: mErr.message });

  return res.status(200).json({
    jurisdictions: jurisdictions || [],
    summary: summary || [],
    monthly: monthly || [],
    basis: basis === "CASH" ? "CASH" : "ACCRUAL",
  });
}
