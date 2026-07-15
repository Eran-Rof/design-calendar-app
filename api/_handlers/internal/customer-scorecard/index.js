// api/internal/customer-scorecard
//
// Chunk E — Customer drill-through scorecard (operator item 1).
//
// GET ?customer_id=<uuid>[&from=YYYY-MM-DD&to=YYYY-MM-DD&brand_id=<uuid>&gender=<code>]
//
// Returns a single structured JSON object backing src/tanda/CustomerScorecard.tsx:
//   {
//     header:  { customer_id, customer_name, customer_code, status,
//                sales_rep_1, sales_rep_2 },               // rep = {id,name,commission_pct}
//     metrics: { balance_cents, avg_days_to_pay,
//                by_brand:[{brand_id,brand_code,brand_name,total_cents}],
//                by_gender:[{gender_code,units,total_cents}],
//                periods: { this_year, this_month, last_month, ly_same }, // each = period block
//                commission_pct, commission_cents, net_profit_cents,
//                gross_sales_cents, dilution_cents, dilution_pct, margin_cents },
//     invoices:[...], sales_orders:[...], journal_entries:[...],
//     notes: { ... }   // per-metric data-source / caveat captions
//   }
//
// ── DATA SOURCES (one comment per metric, per the chunk brief) ───────────────
//  • balance_cents      = SUM(ar_invoices.total_amount_cents − paid_amount_cents)
//                         over NON-void invoices for this customer (all-time, the
//                         brief defines "Customer balance" as open AR, not windowed).
//  • avg_days_to_pay    = avg(receipt_date − invoice_date) over invoices that have
//                         at least one ar_receipt_applications row, weighting each
//                         application by the invoice's first receipt. ar_receipts
//                         carries receipt_date; ar_receipt_applications links it to
//                         ar_invoices. NULL → "—" when no paid invoices.
//  • by_brand           = SUM(sales_orders.total_cents) grouped by sales_orders.brand_id.
//                         ar_invoices carry NO brand column, but sales_orders do
//                         (P16 brand_id). Brand purchases are therefore taken from the
//                         customer's sales orders. Per-brand rows only surface in the UI
//                         when >1 distinct brand; a grand total is always returned.
//  • by_gender          = SUM(ar_invoice_lines.line_total_cents) + units, joined
//                         ar_invoice_lines.inventory_item_id → ip_item_master.gender_code.
//  • period blocks      = ar_invoice_lines (quantity, line_total_cents, cogs_cents)
//                         joined to ar_invoices by invoice_date window. units=Σquantity,
//                         AUR=revenue/units, margin=Σ(line_total−cogs),
//                         margin%=margin/revenue. cogs_cents may be NULL on
//                         manually-keyed lines → those lines contribute 0 COGS and the
//                         block sets cogs_complete=false so the UI can caption it.
//  • dilution_cents      = Σ(debit−credit) on journal_entry_lines whose account is
//                         account_type='contra_revenue' AND account_subtype='dilution',
//                         for posted JEs with source_table='ar_invoices' and
//                         source_id ∈ this customer's invoice ids. Best-effort
//                         attribution (the only customer linkage available). 0 when no
//                         dilution accounts/postings exist.
//  • commission         = (sales_rep_1_commission_pct + sales_rep_2_commission_pct)
//                         applied to NET sales (gross − dilution) for the window.
//  • net_profit_cents   = margin_cents − commission_cents − dilution_cents (window).

import { createClient } from "@supabase/supabase-js";
import { resolveMarginAccess } from "../../../_lib/rbac/marginAccess.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

async function resolveDefaultEntity(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

// ── date-window helpers (UTC, calendar-based) ────────────────────────────────
function ymd(d) { return d.toISOString().slice(0, 10); }
function periodWindows(today) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-based
  const thisYear   = { from: `${y}-01-01`, to: ymd(today) };
  const thisMonth  = { from: ymd(new Date(Date.UTC(y, m, 1))), to: ymd(today) };
  const lastMonth  = {
    from: ymd(new Date(Date.UTC(y, m - 1, 1))),
    to:   ymd(new Date(Date.UTC(y, m, 0))), // day 0 of this month = last day of prev
  };
  // LY-same-period = this-year window shifted back one year.
  const lySame = { from: `${y - 1}-01-01`, to: ymd(new Date(Date.UTC(y - 1, m, today.getUTCDate()))) };
  return { thisYear, thisMonth, lastMonth, lySame };
}

// Build one period block from a list of {invoice_date, quantity, line_total_cents, cogs_cents}.
function buildPeriodBlock(lines, from, to, dilutionCents) {
  let units = 0, revenue = 0, cogs = 0, cogsComplete = true, closeoutRevenue = 0;
  for (const ln of lines) {
    const dt = ln.invoice_date;
    if (!dt || dt < from || dt > to) continue;
    units   += n(ln.quantity);
    revenue += n(ln.line_total_cents);
    if (ln.is_closeout) closeoutRevenue += n(ln.line_total_cents);
    if (ln.cogs_cents == null) cogsComplete = false;
    cogs    += n(ln.cogs_cents);
  }
  const margin = revenue - cogs;
  const aur = units > 0 ? Math.round(revenue / units) : null;
  const marginPct = revenue !== 0 ? margin / revenue : null;
  const dil = n(dilutionCents);
  const dilPct = revenue !== 0 ? dil / revenue : null;
  return {
    from, to,
    units,
    aur_cents: aur,
    revenue_cents: revenue,
    closeout_revenue_cents: closeoutRevenue,
    cogs_cents: cogs,
    cogs_complete: cogsComplete,
    margin_cents: margin,
    margin_pct: marginPct,
    dilution_cents: dil,
    dilution_pct: dilPct,
  };
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

  const entityId = await resolveDefaultEntity(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const customerId = (url.searchParams.get("customer_id") || "").trim();
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: "customer_id (uuid) is required" });
  const from = (url.searchParams.get("from") || "").trim();
  const to   = (url.searchParams.get("to") || "").trim();
  const brandId = (url.searchParams.get("brand_id") || "").trim();
  const gender  = (url.searchParams.get("gender") || "").trim();
  if (from && !ISO_DATE_RE.test(from)) return res.status(400).json({ error: "from must be YYYY-MM-DD" });
  if (to && !ISO_DATE_RE.test(to)) return res.status(400).json({ error: "to must be YYYY-MM-DD" });

  try {
    // ── Header: customer + sales reps ────────────────────────────────────────
    const { data: cust } = await admin
      .from("customers")
      .select("id, name, code, status, sales_rep_1_id, sales_rep_1_commission_pct, sales_rep_2_id, sales_rep_2_commission_pct, closeout_commission_pct, default_brand_id")
      .eq("id", customerId)
      .maybeSingle();
    if (!cust) return res.status(404).json({ error: "Customer not found" });

    const repIds = [cust.sales_rep_1_id, cust.sales_rep_2_id].filter(Boolean);
    const empById = new Map();
    if (repIds.length) {
      const { data: emps } = await admin
        .from("employees")
        .select("id, display_name, first_name, last_name, code")
        .in("id", repIds);
      for (const e of emps || []) {
        const name = e.display_name || `${e.first_name || ""} ${e.last_name || ""}`.trim() || e.code || e.id;
        empById.set(e.id, name);
      }
    }
    const mkRep = (id, pct) => id ? { id, name: empById.get(id) || id, commission_pct: n(pct) } : null;

    // ── Invoices (all, non-void for balance; full list for the Invoices tab) ──
    const { data: invAll } = await admin
      .from("ar_invoices")
      .select("id, invoice_number, invoice_kind, gl_status, invoice_date, due_date, total_amount_cents, paid_amount_cents, source, accrual_je_id, sales_order_id")
      .eq("entity_id", entityId)
      .eq("customer_id", customerId)
      .order("invoice_date", { ascending: false })
      .limit(2000);
    const invoices = invAll || [];

    // Closeout-order tagging — an invoice is "closeout" when its sales order is
    // flagged is_closeout. Used to apply the customer's closeout commission rate
    // to that portion of sales (per-invoice → per-line below).
    const soIds = Array.from(new Set(invoices.map((i) => i.sales_order_id).filter(Boolean)));
    const closeoutSo = new Set();
    if (soIds.length) {
      const { data: sos } = await admin
        .from("sales_orders").select("id, is_closeout").in("id", soIds.slice(0, 1000));
      for (const s of sos || []) if (s.is_closeout) closeoutSo.add(s.id);
    }
    const closeoutByInvoice = new Map(invoices.map((i) => [i.id, !!(i.sales_order_id && closeoutSo.has(i.sales_order_id))]));

    // Balance = open AR over non-void invoices (all-time, per brief).
    let balanceCents = 0;
    for (const inv of invoices) {
      if (inv.gl_status === "void") continue;
      balanceCents += n(inv.total_amount_cents) - n(inv.paid_amount_cents);
    }

    const nonVoidIds = invoices.filter((i) => i.gl_status !== "void").map((i) => i.id);
    const invDateById = new Map(invoices.map((i) => [i.id, i.invoice_date]));

    // ── Avg days to pay — ar_receipt_applications → ar_receipts.receipt_date ──
    let avgDaysToPay = null;
    if (nonVoidIds.length) {
      const { data: apps } = await admin
        .from("ar_receipt_applications")
        .select("ar_invoice_id, ar_receipt_id")
        .in("ar_invoice_id", nonVoidIds.slice(0, 1000));
      const receiptIds = Array.from(new Set((apps || []).map((a) => a.ar_receipt_id).filter(Boolean)));
      const receiptDate = new Map();
      if (receiptIds.length) {
        const { data: rcpts } = await admin
          .from("ar_receipts")
          .select("id, receipt_date, is_void")
          .in("id", receiptIds.slice(0, 1000));
        for (const r of rcpts || []) if (!r.is_void) receiptDate.set(r.id, r.receipt_date);
      }
      // Per invoice, take the EARLIEST receipt date as the pay date.
      const firstPay = new Map();
      for (const a of apps || []) {
        const rd = receiptDate.get(a.ar_receipt_id);
        if (!rd) continue;
        const cur = firstPay.get(a.ar_invoice_id);
        if (!cur || rd < cur) firstPay.set(a.ar_invoice_id, rd);
      }
      const diffs = [];
      for (const [invId, payDate] of firstPay) {
        const invDate = invDateById.get(invId);
        if (!invDate) continue;
        const days = (Date.parse(payDate) - Date.parse(invDate)) / 86400000;
        if (Number.isFinite(days)) diffs.push(days);
      }
      if (diffs.length) avgDaysToPay = Math.round((diffs.reduce((s, d) => s + d, 0) / diffs.length) * 10) / 10;
    }

    // ── Invoice lines (for gender + period blocks) ───────────────────────────
    // Pull lines for this customer's non-void invoices, with item gender.
    const linesEnriched = [];
    if (nonVoidIds.length) {
      const { data: lines } = await admin
        .from("ar_invoice_lines")
        .select("ar_invoice_id, quantity, line_total_cents, cogs_cents, inventory_item_id")
        .in("ar_invoice_id", nonVoidIds.slice(0, 1000));
      const itemIds = Array.from(new Set((lines || []).map((l) => l.inventory_item_id).filter(Boolean)));
      const genderByItem = new Map();
      if (itemIds.length) {
        const { data: items } = await admin
          .from("ip_item_master")
          .select("id, gender_code")
          .in("id", itemIds.slice(0, 1000));
        for (const it of items || []) genderByItem.set(it.id, it.gender_code || null);
      }
      for (const l of lines || []) {
        linesEnriched.push({
          invoice_date: invDateById.get(l.ar_invoice_id) || null,
          quantity: l.quantity,
          line_total_cents: l.line_total_cents,
          cogs_cents: l.cogs_cents,
          gender_code: genderByItem.get(l.inventory_item_id) || null,
          is_closeout: closeoutByInvoice.get(l.ar_invoice_id) || false,
        });
      }
    }

    // Apply gender filter (affects gender breakdown + period blocks when set).
    const filteredLines = gender ? linesEnriched.filter((l) => l.gender_code === gender) : linesEnriched;

    // ── by_gender ─────────────────────────────────────────────────────────────
    const genderAgg = new Map();
    for (const l of filteredLines) {
      const g = l.gender_code || "—";
      const cur = genderAgg.get(g) || { gender_code: g, units: 0, total_cents: 0 };
      cur.units += n(l.quantity);
      cur.total_cents += n(l.line_total_cents);
      genderAgg.set(g, cur);
    }
    const byGender = Array.from(genderAgg.values()).sort((a, b) => b.total_cents - a.total_cents);

    // ── Sales orders (for by_brand + the SO tab) ─────────────────────────────
    let soQuery = admin
      .from("sales_orders")
      .select("id, so_number, brand_id, status, order_date, requested_ship_date, cancel_date, subtotal_cents, total_cents, currency")
      .eq("entity_id", entityId)
      .eq("customer_id", customerId)
      .order("order_date", { ascending: false })
      .limit(2000);
    if (brandId && UUID_RE.test(brandId)) soQuery = soQuery.eq("brand_id", brandId);
    const { data: soAll } = await soQuery;
    const salesOrders = soAll || [];

    // by_brand from sales_orders.total_cents grouped by brand_id (only meaningful breakdown source).
    const brandIds = Array.from(new Set(salesOrders.map((s) => s.brand_id).filter(Boolean)));
    const brandMeta = new Map();
    if (brandIds.length) {
      const { data: brands } = await admin
        .from("brand_master")
        .select("id, code, name")
        .in("id", brandIds);
      for (const b of brands || []) brandMeta.set(b.id, b);
    }
    const brandAgg = new Map();
    for (const s of salesOrders) {
      const key = s.brand_id || "—";
      const cur = brandAgg.get(key) || { brand_id: s.brand_id || null, brand_code: null, brand_name: null, total_cents: 0, order_count: 0 };
      const meta = s.brand_id ? brandMeta.get(s.brand_id) : null;
      cur.brand_code = meta?.code || null;
      cur.brand_name = meta?.name || (s.brand_id ? null : "(no brand)");
      cur.total_cents += n(s.total_cents);
      cur.order_count += 1;
      brandAgg.set(key, cur);
    }
    const byBrand = Array.from(brandAgg.values()).sort((a, b) => b.total_cents - a.total_cents);
    const brandGrandTotalCents = byBrand.reduce((s, b) => s + b.total_cents, 0);

    // ── Dilution attribution (customer's invoices → contra_revenue/dilution JE lines) ──
    let dilutionByWindow = { thisYear: 0, thisMonth: 0, lastMonth: 0, lySame: 0 };
    let dilutionAccountsExist = false;
    {
      const { data: dilAccts } = await admin
        .from("gl_accounts")
        .select("id")
        .eq("entity_id", entityId)
        .eq("account_type", "contra_revenue")
        .eq("account_subtype", "dilution");
      const dilAcctIds = new Set((dilAccts || []).map((a) => a.id));
      dilutionAccountsExist = dilAcctIds.size > 0;
      if (dilAcctIds.size && nonVoidIds.length) {
        // JEs sourced from this customer's invoices.
        const { data: jes } = await admin
          .from("journal_entries")
          .select("id, posting_date, status")
          .eq("entity_id", entityId)
          .eq("source_table", "ar_invoices")
          .in("source_id", nonVoidIds.slice(0, 1000));
        const jePosted = (jes || []).filter((j) => j.status === "posted");
        const jeDate = new Map(jePosted.map((j) => [j.id, j.posting_date]));
        const jeIds = jePosted.map((j) => j.id);
        if (jeIds.length) {
          const { data: jelines } = await admin
            .from("journal_entry_lines")
            .select("journal_entry_id, account_id, debit, credit")
            .in("journal_entry_id", jeIds.slice(0, 1000));
          const w = periodWindows(new Date());
          for (const jl of jelines || []) {
            if (!dilAcctIds.has(jl.account_id)) continue;
            const amt = n(jl.debit) - n(jl.credit); // contra_revenue: DR positive
            const dt = jeDate.get(jl.journal_entry_id);
            if (!dt) continue;
            if (dt >= w.thisYear.from && dt <= w.thisYear.to)   dilutionByWindow.thisYear += amt;
            if (dt >= w.thisMonth.from && dt <= w.thisMonth.to) dilutionByWindow.thisMonth += amt;
            if (dt >= w.lastMonth.from && dt <= w.lastMonth.to) dilutionByWindow.lastMonth += amt;
            if (dt >= w.lySame.from && dt <= w.lySame.to)       dilutionByWindow.lySame += amt;
          }
        }
      }
    }

    // ── Period blocks ─────────────────────────────────────────────────────────
    const w = periodWindows(new Date());
    const periods = {
      this_year:  buildPeriodBlock(filteredLines, w.thisYear.from, w.thisYear.to, dilutionByWindow.thisYear),
      this_month: buildPeriodBlock(filteredLines, w.thisMonth.from, w.thisMonth.to, dilutionByWindow.thisMonth),
      last_month: buildPeriodBlock(filteredLines, w.lastMonth.from, w.lastMonth.to, dilutionByWindow.lastMonth),
      ly_same:    buildPeriodBlock(filteredLines, w.lySame.from, w.lySame.to, dilutionByWindow.lySame),
    };

    // ── Commission + net profit (basis = This-Year window) ───────────────────
    // Normal sales use the rep rate (rep1% + rep2%); the closeout portion (sales
    // from SOs flagged is_closeout) uses the customer's closeout rate instead,
    // when one is set. Dilution is apportioned proportionally to each portion.
    const normalPct = n(cust.sales_rep_1_commission_pct) + n(cust.sales_rep_2_commission_pct);
    const hasCloseoutRate = cust.closeout_commission_pct != null && cust.closeout_commission_pct !== "";
    const closeoutPct = hasCloseoutRate ? n(cust.closeout_commission_pct) : normalPct;
    const grossSalesCents = periods.this_year.revenue_cents;
    const closeoutGrossCents = periods.this_year.closeout_revenue_cents;
    const dilutionCents = periods.this_year.dilution_cents;
    const netSalesCents = grossSalesCents - dilutionCents;
    // Split net sales by the closeout share of gross.
    const closeoutNetCents = grossSalesCents > 0 ? Math.round(netSalesCents * (closeoutGrossCents / grossSalesCents)) : 0;
    const normalNetCents = netSalesCents - closeoutNetCents;
    const commissionCents = Math.round(normalNetCents * (normalPct / 100) + closeoutNetCents * (closeoutPct / 100));
    // Reported headline % = effective blended rate over net sales (keeps pct×net≈cents).
    const commissionPct = netSalesCents !== 0 ? +((commissionCents / netSalesCents) * 100).toFixed(3) : normalPct;
    const marginCents = periods.this_year.margin_cents;
    const netProfitCents = marginCents - commissionCents - dilutionCents;

    // ── Journal entries (sourced from this customer's invoices) ──────────────
    let journalEntries = [];
    if (nonVoidIds.length) {
      const { data: jes } = await admin
        .from("journal_entries")
        .select("id, posting_date, journal_type, basis, source_table, source_id, description, status")
        .eq("entity_id", entityId)
        .eq("source_table", "ar_invoices")
        .in("source_id", nonVoidIds.slice(0, 1000))
        .order("posting_date", { ascending: false })
        .limit(1000);
      journalEntries = jes || [];
    }

    // Margin visibility gate (P14 `margins` capability). Strip margin fields
    // from every period + the metrics summary for callers without the grant.
    // net_profit_cents stays (a distinct metric the UI does not gate as margin).
    // Fail-open until RBAC_MODE=enforce, so a no-op today.
    const { canView: canViewMargins } = await resolveMarginAccess(req);
    if (!canViewMargins) {
      for (const p of Object.values(periods)) {
        if (p && typeof p === "object") { delete p.margin_cents; delete p.margin_pct; }
      }
    }

    // Optional brand filter note: brand filter applies to SO/by_brand; AR lines
    // (gender, periods) have no brand column so are unaffected by brand_id.
    return res.status(200).json({
      header: {
        customer_id: cust.id,
        customer_name: cust.name,
        customer_code: cust.code,
        status: cust.status,
        sales_rep_1: mkRep(cust.sales_rep_1_id, cust.sales_rep_1_commission_pct),
        sales_rep_2: mkRep(cust.sales_rep_2_id, cust.sales_rep_2_commission_pct),
        closeout_commission_pct: hasCloseoutRate ? n(cust.closeout_commission_pct) : null,
      },
      metrics: {
        balance_cents: balanceCents,
        avg_days_to_pay: avgDaysToPay,
        by_brand: byBrand,
        by_brand_grand_total_cents: brandGrandTotalCents,
        by_gender: byGender,
        periods,
        commission_pct: commissionPct,
        commission_cents: commissionCents,
        closeout_sales_cents: closeoutGrossCents,
        closeout_commission_pct: hasCloseoutRate ? closeoutPct : null,
        gross_sales_cents: grossSalesCents,
        dilution_cents: dilutionCents,
        dilution_pct: grossSalesCents !== 0 ? dilutionCents / grossSalesCents : null,
        margin_cents: canViewMargins ? marginCents : undefined,
        net_profit_cents: netProfitCents,
        net_profit_basis: "This-Year window: margin − commission − dilution",
      },
      invoices,
      sales_orders: salesOrders,
      journal_entries: journalEntries,
      notes: {
        balance: "Open AR = Σ(total − paid) over non-void invoices (all-time).",
        avg_days_to_pay: avgDaysToPay == null ? "needs paid invoices with receipt applications" : "avg(first receipt_date − invoice_date) over paid invoices.",
        by_brand: "From sales_orders.total_cents grouped by brand_id (AR invoices carry no brand).",
        by_gender: "ar_invoice_lines → ip_item_master.gender_code; lines with no item show as '—'.",
        dilution: dilutionAccountsExist
          ? "Σ(DR−CR) on contra_revenue/dilution JE lines for JEs sourced from this customer's invoices."
          : "needs contra_revenue/dilution GL accounts (none configured) — shown as 0.",
        commission: "(rep1% + rep2%) × normal net sales + closeout% × closeout net sales (gross − dilution, This-Year window). Closeout net = sales from SOs flagged is_closeout; uses the customer's closeout rate when set, else the rep rate.",
        net_profit: "margin − commission − dilution, This-Year window.",
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
