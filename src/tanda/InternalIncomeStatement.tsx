// src/tanda/InternalIncomeStatement.tsx
//
// Tangerine P5-3 / M6 — Income Statement (P&L) admin panel.
// Per docs/tangerine/P5-close-core-financials-architecture.md §5.
//
// Reads /api/internal/income-statement?basis=ACCRUAL|CASH&from=YYYY-MM-DD&to=YYYY-MM-DD.
//
// Layout (3 sections per arch §5.3):
//   1. Revenue        — account_type IN ('revenue','contra_revenue')        → NET REVENUE
//   2. COGS           — account_type='expense' AND code LIKE '5%'           → COGS
//   3. Operating Exp. — account_type='expense' AND NOT code LIKE '5%'       → OPEX
//
// Subtotals:
//   Net Revenue
//   COGS
//   Gross Margin   = Net Revenue − COGS    (green if positive, red if negative)
//   OPEX
//   Operating Income = Gross Margin − OPEX
//   Net Income       = Operating Income     (until M22 adds depreciation)
//
// Sections are collapsible (default open). Currency right-aligned + tabular-nums.

import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

type ISRow = {
  entity_id: string;
  basis: string;
  account_type: "revenue" | "contra_revenue" | "expense" | string;
  code: string;
  name: string;
  amount_cents: number | string;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const tdNum: React.CSSProperties = {
  ...td, textAlign: "right", fontVariantNumeric: "tabular-nums",
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function fyStartISO(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

// Compute net amount sign:
//   revenue          → amount_cents (already CR-DR positive)
//   contra_revenue   → amount_cents (already DR-CR positive, REDUCES revenue)
//   expense          → amount_cents (already DR-CR positive)
//
// For NET REVENUE we sum revenue rows MINUS contra_revenue rows.
function rowAmount(r: ISRow): number {
  return Number(r.amount_cents || 0);
}

function classifyRow(r: ISRow): "revenue" | "contra_revenue" | "cogs" | "opex" | "other" {
  if (r.account_type === "revenue") return "revenue";
  if (r.account_type === "contra_revenue") return "contra_revenue";
  if (r.account_type === "expense") {
    const code = String(r.code || "");
    if (code.startsWith("5")) return "cogs";
    return "opex";
  }
  return "other";
}

type SectionProps = {
  title: string;
  rows: ISRow[];
  total: number;
  open: boolean;
  onToggle: () => void;
  totalLabel?: string;
  totalColor?: string;
};

function Section({ title, rows, total, open, onToggle, totalLabel, totalColor }: SectionProps) {
  return (
    <div style={{ marginBottom: 16, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%", textAlign: "left", padding: "10px 14px",
          background: "#0b1220", color: C.text, border: "none", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontSize: 14, fontWeight: 600,
        }}
      >
        <span>
          <span style={{ marginRight: 8, color: C.textMuted }}>{open ? "▼" : "▶"}</span>
          {title}
          <span style={{ color: C.textMuted, marginLeft: 8, fontWeight: 400, fontSize: 12 }}>
            ({rows.length} {rows.length === 1 ? "account" : "accounts"})
          </span>
        </span>
        <span style={{ ...tdNum, padding: 0, fontWeight: 700, color: totalColor || C.text, fontSize: 14 }}>
          {totalLabel ? `${totalLabel} ` : ""}{fmtCents(total)}
        </span>
      </button>
      {open && rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 120 }}>Code</th>
              <th style={th}>Account</th>
              <th style={{ ...th, textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const amt = rowAmount(r);
              return (
                <tr key={`${r.account_type}-${r.code}`}>
                  <td style={{ ...td, color: C.textMuted, fontVariantNumeric: "tabular-nums" }}>{r.code}</td>
                  <td style={td}>{r.name}</td>
                  <td style={{ ...tdNum, color: amt < 0 ? C.danger : C.text }}>{fmtCents(amt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {open && rows.length === 0 && (
        <div style={{ padding: 14, color: C.textMuted, fontSize: 12, fontStyle: "italic" }}>
          No activity in this section for the selected range.
        </div>
      )}
    </div>
  );
}

export default function InternalIncomeStatement() {
  const [rows, setRows] = useState<ISRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [basis, setBasis] = useState<"ACCRUAL" | "CASH">("ACCRUAL");
  const [from, setFrom] = useState<string>(fyStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [openRev, setOpenRev] = useState(true);
  const [openCogs, setOpenCogs] = useState(true);
  const [openOpex, setOpenOpex] = useState(true);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("basis", basis);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const r = await fetch(`/api/internal/income-statement?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setRows((data.rows || []) as ISRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Partition rows into 4 buckets.
  const revenueRows = rows.filter((r) => classifyRow(r) === "revenue");
  const contraRows  = rows.filter((r) => classifyRow(r) === "contra_revenue");
  const cogsRows    = rows.filter((r) => classifyRow(r) === "cogs");
  const opexRows    = rows.filter((r) => classifyRow(r) === "opex");

  const grossRevenue = revenueRows.reduce((s, r) => s + rowAmount(r), 0);
  const contraTotal  = contraRows.reduce((s, r) => s + rowAmount(r), 0);
  const netRevenue   = grossRevenue - contraTotal;
  const cogs         = cogsRows.reduce((s, r) => s + rowAmount(r), 0);
  const opex         = opexRows.reduce((s, r) => s + rowAmount(r), 0);
  const grossMargin  = netRevenue - cogs;
  const operatingIncome = grossMargin - opex;
  const netIncome    = operatingIncome; // M22 will add depreciation later

  // Revenue section combines revenue + contra_revenue rows for display, but the
  // section total is NET REVENUE (revenue minus contra).
  const revenueDisplayRows = [...revenueRows, ...contraRows];

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Income Statement</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          basis: <strong>{basis}</strong>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 0, border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
          {(["ACCRUAL", "CASH"] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBasis(b)}
              style={{
                padding: "6px 14px",
                background: basis === b ? C.primary : C.card,
                color: basis === b ? "white" : C.textSub,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {b}
            </button>
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          From:
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          To:
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
          />
        </label>
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <ExportButton
          rows={(() => {
            const out: Array<Record<string, unknown>> = [];
            for (const r of revenueRows) {
              out.push({ section: "Revenue", kind: "row", code: r.code, name: r.name, amount_cents: rowAmount(r) });
            }
            for (const r of contraRows) {
              out.push({ section: "Revenue", kind: "row", code: r.code, name: r.name, amount_cents: rowAmount(r) });
            }
            out.push({ section: "Revenue", kind: "subtotal", code: "", name: "NET REVENUE", amount_cents: netRevenue });
            for (const r of cogsRows) {
              out.push({ section: "Cost of Goods Sold", kind: "row", code: r.code, name: r.name, amount_cents: rowAmount(r) });
            }
            out.push({ section: "Cost of Goods Sold", kind: "subtotal", code: "", name: "COGS", amount_cents: cogs });
            out.push({ section: "Gross Margin", kind: "subtotal", code: "", name: "Gross Margin", amount_cents: grossMargin });
            for (const r of opexRows) {
              out.push({ section: "Operating Expenses", kind: "row", code: r.code, name: r.name, amount_cents: rowAmount(r) });
            }
            out.push({ section: "Operating Expenses", kind: "subtotal", code: "", name: "OPEX", amount_cents: opex });
            out.push({ section: "Operating Income", kind: "subtotal", code: "", name: "Operating Income", amount_cents: operatingIncome });
            out.push({ section: "Net Income", kind: "total", code: "", name: "NET INCOME", amount_cents: netIncome });
            return out;
          })()}
          filename={`income-statement-${basis}-${from}-to-${to}`}
          sheetName="Income Statement"
          columns={[
            { key: "section",      header: "Section" },
            { key: "kind",         header: "Kind" },
            { key: "code",         header: "Code" },
            { key: "name",         header: "Account" },
            { key: "amount_cents", header: "Amount", format: "currency_cents" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : (
        <>
          <Section
            title="Revenue"
            rows={revenueDisplayRows}
            total={netRevenue}
            totalLabel="NET REVENUE"
            open={openRev}
            onToggle={() => setOpenRev((v) => !v)}
          />
          <Section
            title="Cost of Goods Sold"
            rows={cogsRows}
            total={cogs}
            totalLabel="COGS"
            open={openCogs}
            onToggle={() => setOpenCogs((v) => !v)}
          />
          <Section
            title="Operating Expenses"
            rows={opexRows}
            total={opex}
            totalLabel="OPEX"
            open={openOpex}
            onToggle={() => setOpenOpex((v) => !v)}
          />

          {/* Footer subtotals — Gross Margin, Operating Income, Net Income. */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <tr>
                  <td style={{ ...td, border: "none", color: C.textSub }}>Net Revenue</td>
                  <td style={{ ...tdNum, border: "none" }}>{fmtCents(netRevenue)}</td>
                </tr>
                <tr>
                  <td style={{ ...td, border: "none", color: C.textSub }}>− Cost of Goods Sold</td>
                  <td style={{ ...tdNum, border: "none" }}>{fmtCents(cogs)}</td>
                </tr>
                <tr>
                  <td style={{ ...td, borderTop: `1px solid ${C.cardBdr}`, borderBottom: "none", fontWeight: 700 }}>
                    Gross Margin
                  </td>
                  <td style={{
                    ...tdNum,
                    borderTop: `1px solid ${C.cardBdr}`,
                    borderBottom: "none",
                    fontWeight: 700,
                    color: grossMargin >= 0 ? C.success : C.danger,
                  }}>
                    {fmtCents(grossMargin)}
                  </td>
                </tr>
                <tr>
                  <td style={{ ...td, border: "none", color: C.textSub }}>− Operating Expenses</td>
                  <td style={{ ...tdNum, border: "none" }}>{fmtCents(opex)}</td>
                </tr>
                <tr>
                  <td style={{ ...td, borderTop: `1px solid ${C.cardBdr}`, borderBottom: "none", fontWeight: 700 }}>
                    Operating Income
                  </td>
                  <td style={{
                    ...tdNum,
                    borderTop: `1px solid ${C.cardBdr}`,
                    borderBottom: "none",
                    fontWeight: 700,
                    color: operatingIncome >= 0 ? C.success : C.danger,
                  }}>
                    {fmtCents(operatingIncome)}
                  </td>
                </tr>
                <tr>
                  <td style={{ ...td, borderTop: `2px solid ${C.cardBdr}`, borderBottom: "none", fontWeight: 700, fontSize: 14 }}>
                    NET INCOME
                  </td>
                  <td style={{
                    ...tdNum,
                    borderTop: `2px solid ${C.cardBdr}`,
                    borderBottom: "none",
                    fontWeight: 700,
                    fontSize: 14,
                    color: netIncome >= 0 ? C.success : C.danger,
                  }}>
                    {fmtCents(netIncome)}
                  </td>
                </tr>
              </tbody>
            </table>
            <div style={{ marginTop: 10, color: C.textMuted, fontSize: 11, fontStyle: "italic" }}>
              Net Income = Operating Income until M22 (Fixed Assets / Depreciation) ships.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
