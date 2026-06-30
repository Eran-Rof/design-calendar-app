// src/tanda/InternalReportsHub.tsx
//
// P24 / M9-full + M46 — Reports & Analytics hub. One executive landing that
// (a) shows headline finance KPIs (open AR / open AP / inventory value at cost /
// open SOs / current period) + cheap derived ratios, (b) renders a few BI
// charts over already-existing report endpoints (spend by vendor / monthly
// spend trend / AR-AP-inventory composition), and (c) links to every financial +
// operational report already in Tangerine, grouped by area. The reports
// themselves were built across P5/P7; this ties them together.
//
// Data sources (all pre-existing — no new endpoints added here):
//   GET /api/internal/finance-kpis        → headline aggregates (cents/counts)
//   GET /api/internal/reports/spend       → by_month / by_vendor / grand_total
// recharts is already a repo dependency; charts live in ./components/MiniCharts.

import { useEffect, useState } from "react";
import { ChartCard, HBarChart, DonutChart, TrendChart, Sparkline } from "./components/MiniCharts";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6",
};

type Kpis = {
  ar_open_cents: number; ap_open_cents: number; inventory_value_cents: number;
  open_so_count: number;
  current_period: { fiscal_year: number; period_number: number; status: string } | null;
};

type Spend = {
  period: { from: string; to: string };
  grand_total: number;
  by_month: { month: string; total: number }[];
  by_vendor: { vendor_id: string; vendor_name: string | null; total: number }[];
};

function money(c: number) { return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }
function moneyDollars(n: number) { return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }
function monthLabel(m: string) {
  // "2026-04" → "Apr"
  const d = new Date(m + "-01T00:00:00");
  return isNaN(d.getTime()) ? m : d.toLocaleString("en-US", { month: "short" });
}

// Switch Tangerine module without a full reload (shell listens to popstate).
function go(key: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("m", key);
  window.history.pushState({ module: key }, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const REPORTS: { group: string; items: { key: string; label: string; emoji: string }[] }[] = [
  { group: "Financial Statements", items: [
    { key: "trial_balance", label: "Trial Balance", emoji: "" },
    { key: "income_statement", label: "Income Statement", emoji: "" },
    { key: "segment_pl", label: "Segment P&L", emoji: "" },
    { key: "balance_sheet", label: "Balance Sheet", emoji: "" },
    { key: "cash_flow", label: "Cash Flow", emoji: "" },
    { key: "year_end_close", label: "Year-End Close", emoji: "" },
  ] },
  { group: "Receivables & Payables", items: [
    { key: "ar_aging", label: "AR Aging", emoji: "" },
    { key: "ap_aging", label: "AP Aging", emoji: "" },
    { key: "ar_invoices", label: "AR Invoices", emoji: "" },
    { key: "ap_invoices", label: "AP Invoices", emoji: "" },
    { key: "bank_reconciliation", label: "Bank Reconciliation", emoji: "" },
  ] },
  { group: "General Ledger", items: [
    { key: "gl_detail", label: "GL Detail", emoji: "" },
    { key: "gl_accounts", label: "Chart of Accounts", emoji: "" },
    { key: "journal_entries", label: "Journal Entries", emoji: "" },
    { key: "gl_periods", label: "Periods", emoji: "" },
  ] },
  { group: "Sales", items: [
    { key: "sales_by_rep", label: "Sales by Rep", emoji: "" },
    { key: "sales_by_customer", label: "Sales by Customer", emoji: "" },
  ] },
];

function Tile({ label, value, color, loading, sub, spark, sparkColor }: {
  label: string; value: string; color: string; loading: boolean;
  sub?: string; spark?: number[]; sparkColor?: string;
}) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div style={{ color, fontSize: 24, fontWeight: 700 }}>{loading ? "…" : value}</div>
      {sub && <div style={{ color: C.textMuted, fontSize: 11, marginTop: 4 }}>{sub}</div>}
      {spark && spark.length >= 2 && (
        <div style={{ marginTop: 8 }}><Sparkline values={spark} color={sparkColor || color} /></div>
      )}
    </div>
  );
}

export default function InternalReportsHub() {
  const [k, setK] = useState<Kpis | null>(null);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [loading, setLoading] = useState(true);
  const [spendLoading, setSpendLoading] = useState(true);

  useEffect(() => {
    fetch("/api/internal/finance-kpis").then((r) => r.json()).then((j) => setK(j)).catch(() => {}).finally(() => setLoading(false));
    fetch("/api/internal/reports/spend").then((r) => r.json()).then((j) => setSpend(j && !j.error ? j : null)).catch(() => {}).finally(() => setSpendLoading(false));
  }, []);

  // Derived ratios (cheap, client-side).
  const arCents = k?.ar_open_cents ?? 0;
  const apCents = k?.ap_open_cents ?? 0;
  const invCents = k?.inventory_value_cents ?? 0;
  const netWorkingCapital = arCents + invCents - apCents; // crude liquidity proxy
  const arApRatio = apCents > 0 ? arCents / apCents : null;

  const monthSpark = (spend?.by_month || []).map((m) => m.total);
  const ytdSpend = spend?.grand_total ?? 0;

  const tiles = [
    { label: "Open AR", value: k ? money(arCents) : "—", color: C.primary },
    { label: "Open AP", value: k ? money(apCents) : "—", color: C.warn },
    { label: "Inventory @ cost", value: k ? money(invCents) : "—", color: C.success },
    { label: "Open sales orders", value: k ? String(k.open_so_count) : "—", color: C.violet },
    { label: "Current period", value: k && k.current_period ? `FY${k.current_period.fiscal_year} P${k.current_period.period_number}` : "—", color: C.textSub },
  ];

  const derivedTiles = [
    {
      label: "Net working capital", value: k ? money(netWorkingCapital) : "—",
      color: netWorkingCapital >= 0 ? C.success : C.danger,
      sub: "AR + inventory − AP",
    },
    {
      label: "AR / AP ratio", value: arApRatio == null ? "—" : `${arApRatio.toFixed(2)}×`,
      color: arApRatio == null ? C.textSub : arApRatio >= 1 ? C.success : C.warn,
      sub: "receivables vs payables cover",
    },
    {
      label: "YTD spend (paid)", value: spend ? moneyDollars(ytdSpend) : "—",
      color: C.primary, sub: "paid vendor invoices, this year",
      spark: monthSpark.length >= 2 ? monthSpark : undefined, sparkColor: C.primary,
    },
    {
      label: "Active vendors (paid)", value: spend ? String(spend.by_vendor.length) : "—",
      color: C.violet, sub: "with paid invoices YTD",
    },
  ];

  // Chart datasets.
  const topVendors = (spend?.by_vendor || []).slice(0, 8).map((v) => ({
    label: v.vendor_name || "Unknown", value: v.total,
  }));
  const monthTrend = (spend?.by_month || []).map((m) => ({ label: monthLabel(m.month), value: m.total }));
  const composition = [
    { label: "Open AR", value: arCents / 100 },
    { label: "Open AP", value: apCents / 100 },
    { label: "Inventory @ cost", value: invCents / 100 },
  ].filter((d) => d.value > 0);

  const noFinance = !loading && arCents === 0 && apCents === 0 && invCents === 0;
  const noSpend = !spendLoading && (!spend || spend.by_vendor.length === 0);

  // Export the full per-vendor spend breakdown backing the "Top vendors" chart
  // (vendor name resolved; spend is in dollars from /reports/spend).
  const spendExportRows = (spend?.by_vendor || []).map((v) => ({
    vendor: v.vendor_name || "Unknown",
    spend: v.total,
  }));
  const spendExportColumns: ExportColumn<{ vendor: string; spend: number }>[] = [
    { key: "vendor", header: "Vendor" },
    { key: "spend",  header: "Spend (YTD)", format: "currency_dollars" },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Reports & Analytics</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>executive KPIs, BI charts + every report in one place</span>
        <span style={{ marginLeft: "auto" }}>
          <ExportButton rows={spendExportRows} filename="vendor-spend" sheetName="Vendor Spend" columns={spendExportColumns} />
        </span>
      </div>

      {/* Headline KPI tiles (the original 4 + period) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 16 }}>
        {tiles.map((t) => (
          <Tile key={t.label} label={t.label} value={t.value} color={t.color} loading={loading} />
        ))}
      </div>

      {/* Derived executive ratios */}
      <div style={{ color: C.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Executive ratios</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 24 }}>
        {derivedTiles.map((t) => (
          <Tile key={t.label} label={t.label} value={t.value} color={t.color}
            loading={loading || spendLoading} sub={t.sub} spark={t.spark} sparkColor={t.sparkColor} />
        ))}
      </div>

      {/* BI charts */}
      <div style={{ color: C.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Business intelligence</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12, marginBottom: 24 }}>
        <ChartCard title="Top vendors by spend" subtitle="paid invoices, YTD"
          empty={noSpend} emptyHint="No paid vendor invoices yet this year.">
          <HBarChart data={topVendors} color={C.primary} />
        </ChartCard>

        <ChartCard title="Monthly spend trend" subtitle="paid invoices by month"
          empty={noSpend} emptyHint="No paid vendor invoices yet this year.">
          <TrendChart data={monthTrend} color={C.success} />
        </ChartCard>

        <ChartCard title="Balance composition" subtitle="open AR vs AP vs inventory @ cost"
          empty={noFinance} emptyHint="Reads $0 until invoices and inventory post.">
          <DonutChart data={composition} />
        </ChartCard>
      </div>

      {/* Report catalog (unchanged) */}
      {REPORTS.map((g) => (
        <div key={g.group} style={{ marginBottom: 20 }}>
          <div style={{ color: C.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{g.group}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {g.items.map((it) => (
              <button key={it.key} onClick={() => go(it.key)} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "12px 14px", cursor: "pointer", color: C.text, fontSize: 14, textAlign: "left", display: "flex", gap: 10, alignItems: "center" }}>
                {it.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>
        KPIs and charts are live aggregates over the ledgers and paid vendor invoices; they read $0 until transactions post. Each report opens in place.
      </div>
    </div>
  );
}
