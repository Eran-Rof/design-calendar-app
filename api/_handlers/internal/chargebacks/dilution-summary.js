// api/internal/chargebacks/dilution-summary
//
// Chargeback Management (#1744) — dilution analytics. Chargeback $ and % of
// gross sales, aggregated by customer, by customer x month, by month and by
// reason. Gross sales come from ar_invoices (v_chargeback_gross_sales view).
//
// Sign convention (factor_chargebacks.amount_cents): POSITIVE = a chargeback
// deduction the customer took; NEGATIVE = a creditback / recovery / reversal.
// "Dilution %" = gross chargeback deductions / gross sales (the standard
// chargeback rate). The customer for a chargeback is resolved as
// COALESCE(factor_chargebacks.customer_id, matched AR invoice's customer_id) so
// the (deliberately unlinked) Macys statement rows still roll up via their
// matched invoices.
//
// All aggregation runs through the pure, unit-tested aggregateDilution() in
// api/_lib/chargebackMatch.js.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { aggregateDilution, isFactorChurnChargeback, netOpenByDocument } from "../../../_lib/chargebackMatch.js";

const FACTOR_CHURN_GROUP = "__factor_churn__";
const FACTOR_CHURN_LABEL = "Factor receivable churn (Manual Charge Back)";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function fetchAll(admin, table, select, tune) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = admin.from(table).select(select).range(from, from + PAGE - 1);
    if (tune) q = tune(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

const ym = (d) => (d ? String(d).slice(0, 7) : null);

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const cbs = await fetchAll(
      admin, "factor_chargebacks",
      "id, customer_id, report_month, item_num, cb_date, amount_cents, reason, reason_code, reason_code_id, matched:ar_invoices!matched_ar_invoice_id(customer_id)"
    );
    const reasonCodes = await fetchAll(admin, "chargeback_reason_codes", "id, code, label, category");
    const reasonById = new Map(reasonCodes.map((r) => [r.id, r]));

    // resolve customer + period per chargeback. `excluded` flags factor
    // receivable churn (Rosenthal "Manual Charge Back" / code 610) — the factor
    // recoursing the whole invoice back to us, NOT a customer deduction — so it
    // is kept out of the dilution rate (tracked separately as excluded_cents).
    const resolved = cbs.map((r) => ({
      cid: r.customer_id || r.matched?.customer_id || null,
      ym: ym(r.report_month),
      amount_cents: Number(r.amount_cents) || 0,
      reason_code_id: r.reason_code_id || null,
      excluded: isFactorChurnChargeback(r),
    }));

    const custIds = [...new Set(resolved.map((r) => r.cid).filter(Boolean))];
    const customers = custIds.length
      ? await fetchAll(admin, "customers", "id, name", (q) => q.in("id", custIds))
      : [];
    const nameById = new Map(customers.map((c) => [c.id, c.name]));

    // gross sales per (customer, month) for these customers
    const sales = custIds.length
      ? await fetchAll(admin, "v_chargeback_gross_sales", "customer_id, ym, gross_sales_cents", (q) => q.in("customer_id", custIds))
      : [];
    const grossByCustomer = {};
    const grossByCustomerMonth = {};
    const grossByMonth = {};
    for (const s of sales) {
      const g = Number(s.gross_sales_cents) || 0;
      grossByCustomer[s.customer_id] = (grossByCustomer[s.customer_id] || 0) + g;
      grossByCustomerMonth[`${s.customer_id}|${s.ym}`] = (grossByCustomerMonth[`${s.customer_id}|${s.ym}`] || 0) + g;
      grossByMonth[s.ym] = (grossByMonth[s.ym] || 0) + g;
    }

    // ── by customer ──────────────────────────────────────────────────────────
    const byCustomer = aggregateDilution(
      resolved.filter((r) => r.cid).map((r) => ({ group: r.cid, label: nameById.get(r.cid) || r.cid, amount_cents: r.amount_cents, excluded: r.excluded })),
      grossByCustomer
    ).map((r) => ({ customer_id: r.group, customer_name: r.label, ...stripGroup(r) }));

    // ── by customer x month ──────────────────────────────────────────────────
    const byCustomerMonth = aggregateDilution(
      resolved.filter((r) => r.cid && r.ym).map((r) => ({ group: `${r.cid}|${r.ym}`, label: nameById.get(r.cid) || r.cid, amount_cents: r.amount_cents, excluded: r.excluded })),
      grossByCustomerMonth
    ).map((r) => {
      const [cid, mm] = r.group.split("|");
      return { customer_id: cid, customer_name: r.label, ym: mm, ...stripGroup(r) };
    });

    // ── by month ─────────────────────────────────────────────────────────────
    const byMonth = aggregateDilution(
      resolved.filter((r) => r.ym).map((r) => ({ group: r.ym, label: r.ym, amount_cents: r.amount_cents, excluded: r.excluded })),
      grossByMonth
    ).map((r) => ({ ym: r.group, ...stripGroup(r) })).sort((a, b) => (a.ym < b.ym ? -1 : 1));

    // ── by reason (% of total deductions, not of sales) ──────────────────────
    // Factor-churn rows roll into their own visible "Factor receivable churn"
    // line (chargeback_cents = 0, excluded_cents shown) so it stays honest but
    // never inflates the deduction share.
    const reasonRows = aggregateDilution(
      resolved.map((r) => {
        if (r.excluded) return { group: FACTOR_CHURN_GROUP, label: FACTOR_CHURN_LABEL, amount_cents: r.amount_cents, excluded: true };
        const rc = r.reason_code_id ? reasonById.get(r.reason_code_id) : null;
        return { group: rc ? rc.code : "__uncoded__", label: rc ? rc.label : "Un-coded", amount_cents: r.amount_cents };
      }),
      {}
    );
    const totalDeductions = reasonRows.reduce((a, r) => a + r.chargeback_cents, 0);
    const byReason = reasonRows.map((r) => {
      const rc = r.group === "__uncoded__" ? null : reasonCodes.find((x) => x.code === r.group);
      return {
        code: r.group === "__uncoded__" ? null : r.group,
        label: r.label,
        category: rc ? rc.category : null,
        ...stripGroup(r),
        pct_of_deductions: totalDeductions > 0 ? Math.round((r.chargeback_cents / totalDeductions) * 10000) / 100 : null,
      };
    });

    // ── un-coded TRUE exposure: net open by document ─────────────────────────
    // Gross un-coded overstates real exposure (~3× in prod): most of it is
    // same-document chargeback/creditback churn. Net each un-coded document
    // (gross deductions − credits on that same doc number) and sum the docs
    // still net-positive. Full doc list drills via
    // /api/internal/chargebacks/drill?by=reason&key=__uncoded__&measure=net_open.
    const uncodedNetOpen = netOpenByDocument(
      cbs
        .filter((r) => !r.reason_code_id && !isFactorChurnChargeback(r))
        .map((r) => ({ item_num: r.item_num, amount_cents: r.amount_cents, cb_date: r.cb_date }))
    );
    const uncoded_net_open = {
      gross_cents: uncodedNetOpen.gross_cents,
      credit_cents: uncodedNetOpen.credit_cents,
      offset_cents: uncodedNetOpen.offset_cents,
      net_open_cents: uncodedNetOpen.net_open_cents,
      doc_count: uncodedNetOpen.doc_count,
      open_doc_count: uncodedNetOpen.open_doc_count,
    };

    const cbTotal = resolved.reduce((a, r) => a + (r.excluded ? 0 : Math.max(0, r.amount_cents)), 0);
    const creditTotal = resolved.reduce((a, r) => a + (r.excluded ? 0 : Math.min(0, r.amount_cents)), 0);
    const totals = {
      chargeback_cents: cbTotal,
      creditback_cents: creditTotal,
      excluded_cents: resolved.reduce((a, r) => a + (r.excluded ? r.amount_cents : 0), 0),
      net_cents: cbTotal + creditTotal,
      count: resolved.length,
      excluded_count: resolved.filter((r) => r.excluded).length,
      matched_count: cbs.filter((r) => r.customer_id || r.matched?.customer_id).length,
    };

    return res.status(200).json({ totals, uncoded_net_open, by_customer: byCustomer, by_customer_month: byCustomerMonth, by_month: byMonth, by_reason: byReason });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

function stripGroup(r) {
  return {
    chargeback_cents: r.chargeback_cents,
    creditback_cents: r.creditback_cents,
    excluded_cents: r.excluded_cents,
    net_cents: r.net_cents,
    gross_sales_cents: r.gross_sales_cents,
    dilution_pct: r.dilution_pct,
    count: r.count,
  };
}
