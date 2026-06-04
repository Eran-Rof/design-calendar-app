// src/tanda/InternalReportsHub.tsx
//
// P24 / M9-full + M46 — Reports & Analytics hub. One executive landing that
// (a) shows headline finance KPIs (open AR / open AP / inventory value at cost /
// open SOs / current period) and (b) links to every financial + operational
// report already in Tangerine, grouped by area. The reports themselves were
// built across P5/P7; this ties them together.

import { useEffect, useState } from "react";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6",
};

type Kpis = { ar_open_cents: number; ap_open_cents: number; inventory_value_cents: number; open_so_count: number; current_period: { fiscal_year: number; period_number: number; status: string } | null };

function money(c: number) { return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }

// Switch Tangerine module without a full reload (shell listens to popstate).
function go(key: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("m", key);
  window.history.pushState({ module: key }, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const REPORTS: { group: string; items: { key: string; label: string; emoji: string }[] }[] = [
  { group: "Financial Statements", items: [
    { key: "trial_balance", label: "Trial Balance", emoji: "📊" },
    { key: "income_statement", label: "Income Statement", emoji: "📈" },
    { key: "balance_sheet", label: "Balance Sheet", emoji: "📋" },
    { key: "cash_flow", label: "Cash Flow", emoji: "💧" },
    { key: "year_end_close", label: "Year-End Close", emoji: "🔚" },
  ] },
  { group: "Receivables & Payables", items: [
    { key: "ar_aging", label: "AR Aging", emoji: "📅" },
    { key: "ap_aging", label: "AP Aging", emoji: "📅" },
    { key: "ar_invoices", label: "AR Invoices", emoji: "🧮" },
    { key: "ap_invoices", label: "AP Invoices", emoji: "🧾" },
    { key: "bank_reconciliation", label: "Bank Reconciliation", emoji: "🏦" },
  ] },
  { group: "General Ledger", items: [
    { key: "gl_detail", label: "GL Detail", emoji: "🔍" },
    { key: "gl_accounts", label: "Chart of Accounts", emoji: "📒" },
    { key: "journal_entries", label: "Journal Entries", emoji: "📓" },
    { key: "gl_periods", label: "Periods", emoji: "🗓️" },
  ] },
  { group: "Sales", items: [
    { key: "sales_by_rep", label: "Sales by Rep", emoji: "🧑‍💼" },
    { key: "sales_by_customer", label: "Sales by Customer", emoji: "🤝" },
  ] },
];

export default function InternalReportsHub() {
  const [k, setK] = useState<Kpis | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/internal/finance-kpis").then((r) => r.json()).then((j) => setK(j)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const tiles = [
    { label: "Open AR", value: k ? money(k.ar_open_cents) : "—", color: C.primary },
    { label: "Open AP", value: k ? money(k.ap_open_cents) : "—", color: C.warn },
    { label: "Inventory @ cost", value: k ? money(k.inventory_value_cents) : "—", color: C.success },
    { label: "Open sales orders", value: k ? String(k.open_so_count) : "—", color: C.violet },
    { label: "Current period", value: k && k.current_period ? `FY${k.current_period.fiscal_year} P${k.current_period.period_number}` : "—", color: C.textSub },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>📊 Reports & Analytics</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>finance overview + every report in one place</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        {tiles.map((t) => (
          <div key={t.label} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 6 }}>{t.label}</div>
            <div style={{ color: t.color, fontSize: 24, fontWeight: 700 }}>{loading ? "…" : t.value}</div>
          </div>
        ))}
      </div>

      {REPORTS.map((g) => (
        <div key={g.group} style={{ marginBottom: 20 }}>
          <div style={{ color: C.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{g.group}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {g.items.map((it) => (
              <button key={it.key} onClick={() => go(it.key)} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "12px 14px", cursor: "pointer", color: C.text, fontSize: 14, textAlign: "left", display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 18 }}>{it.emoji}</span>{it.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>
        KPIs are live aggregates over the ledgers; they read $0 until transactions post. Each report opens in place.
      </div>
    </div>
  );
}
