// src/tanda/InternalBalanceSheet.tsx
//
// Tangerine P5-4 — Balance Sheet admin panel.
//
// Three-column layout (Assets / Liabilities / Equity) with per-section
// subtotals + grand total + accounting-equation variance footer.
//
// The Equity column ends with a synthetic "Current Year Earnings" row that
// is computed in the UI from a sibling /api/internal/income-statement fetch
// (net income = Σ(revenue net credits) − Σ(expense net debits) for
// posting_date <= as_of). Until the year-end closing JE rolls it into
// Retained Earnings (see P5-6), this is how the BS stays in balance.
//
// Per docs/tangerine/P5-close-core-financials-architecture.md §6.

import { useEffect, useState } from "react";

type Basis = "ACCRUAL" | "CASH";

type BSRow = {
  entity_id: string;
  basis: string;
  account_type: "asset" | "contra_asset" | "liability" | "equity" | string;
  code: string;
  name: string;
  balance_cents: number | string;
};

// IS row shape — see InternalIncomeStatement / P5-3. We only need account_type
// + amount_cents to compute net income.
type ISRow = {
  account_type: "revenue" | "contra_revenue" | "expense" | string;
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
const btnSecondaryActive: React.CSSProperties = {
  ...btnSecondary, background: C.primary, color: "#fff", borderColor: C.primary,
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
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const tdNum: React.CSSProperties = {
  ...td, textAlign: "right", fontVariantNumeric: "tabular-nums",
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearStartISO(isoDate: string): string {
  // YYYY-01-01 for the year embedded in isoDate.
  const yr = isoDate.slice(0, 4);
  return `${yr}-01-01`;
}

export default function InternalBalanceSheet() {
  const [rows, setRows] = useState<BSRow[]>([]);
  const [currentYearEarnings, setCurrentYearEarnings] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [basis, setBasis] = useState<Basis>("ACCRUAL");
  const [asOf, setAsOf] = useState<string>(todayISO());

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      // Primary fetch: balance sheet rows.
      const bsParams = new URLSearchParams({ basis, as_of: asOf });
      const bsRes = await fetch(`/api/internal/balance-sheet?${bsParams.toString()}`);
      if (!bsRes.ok) {
        throw new Error((await bsRes.json().catch(() => ({}))).error || `HTTP ${bsRes.status}`);
      }
      const bsData = await bsRes.json();
      setRows((bsData.rows || []) as BSRow[]);

      // Sibling fetch: income statement for current-year net income.
      // YTD = year-start through as_of, same basis.
      const isParams = new URLSearchParams({
        basis,
        from: yearStartISO(asOf),
        to: asOf,
      });
      const isRes = await fetch(`/api/internal/income-statement?${isParams.toString()}`);
      if (isRes.ok) {
        const isData = await isRes.json();
        const isRows = (isData.rows || []) as ISRow[];
        // Net income = revenue (net credits) - expense (net debits).
        // The IS view already encodes the sign per account_type:
        //   revenue        : credit - debit (positive = revenue earned)
        //   contra_revenue : debit - credit (positive = reduces revenue)
        //   expense        : debit - credit (positive = expense incurred)
        // So: net_income = Σ(revenue) - Σ(contra_revenue) - Σ(expense)
        let revenueNet = 0;
        let contraRevenueNet = 0;
        let expenseNet = 0;
        for (const r of isRows) {
          const amt = Number(r.amount_cents || 0);
          if (r.account_type === "revenue") revenueNet += amt;
          else if (r.account_type === "contra_revenue") contraRevenueNet += amt;
          else if (r.account_type === "expense") expenseNet += amt;
        }
        setCurrentYearEarnings(revenueNet - contraRevenueNet - expenseNet);
      } else {
        // IS endpoint not yet deployed (P5-3 may still be in flight) — fall
        // back to zero. Variance footer will show the gap until P5-3 ships.
        setCurrentYearEarnings(0);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [basis, asOf]);

  // ── Bucket rows by section ──────────────────────────────────────────────
  const assetsRows  = rows.filter((r) => r.account_type === "asset" || r.account_type === "contra_asset");
  const liabRows    = rows.filter((r) => r.account_type === "liability");
  const equityRows  = rows.filter((r) => r.account_type === "equity");

  const sumCents = (rs: BSRow[]) => rs.reduce((acc, r) => acc + Number(r.balance_cents || 0), 0);

  // For Assets, contra_asset balances are subtracted (rendered as negative)
  // visually but the underlying SUM already encodes the sign correctly
  // because we render r.balance_cents directly and total is straight sum.
  // Net Assets = Σ(assets) - Σ(contra_assets) — equivalent to summing all
  // balance_cents AFTER treating contra_asset rows as negative for display.
  const totalAssetsRaw       = sumCents(assetsRows.filter((r) => r.account_type === "asset"));
  const totalContraAssets    = sumCents(assetsRows.filter((r) => r.account_type === "contra_asset"));
  const totalAssetsNet       = totalAssetsRaw - totalContraAssets;
  const totalLiabilities     = sumCents(liabRows);
  const totalEquity          = sumCents(equityRows);
  const totalEquityWithCYE   = totalEquity + currentYearEarnings;

  // Accounting equation: Assets = Liabilities + Equity + CurrentYearEarnings
  // Variance = Assets − Liabilities − Equity − CurrentYearEarnings.
  const variance = totalAssetsNet - totalLiabilities - totalEquityWithCYE;

  function renderSection(
    title: string,
    sectionRows: BSRow[],
    totalLabel: string,
    totalValue: number,
    options?: { extraTrailingRow?: { label: string; value: number; indent?: boolean } },
  ) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ background: "#0b1220", padding: "10px 12px", fontSize: 13, fontWeight: 700, color: C.textSub, borderBottom: `1px solid ${C.cardBdr}` }}>
          {title}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: "65%" }}>Account</th>
              <th style={{ ...th, textAlign: "right" }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {sectionRows.length === 0 && !options?.extraTrailingRow && (
              <tr>
                <td style={{ ...td, color: C.textMuted, textAlign: "center" }} colSpan={2}>—</td>
              </tr>
            )}
            {sectionRows.map((r) => {
              const isContra = r.account_type === "contra_asset";
              // contra_asset: render with indent + negative sign (the stored
              // balance_cents is positive — it's a credit reducing the asset).
              const displayBalance = isContra ? -Number(r.balance_cents || 0) : Number(r.balance_cents || 0);
              return (
                <tr key={`${r.account_type}-${r.code}`}>
                  <td style={{ ...td, paddingLeft: isContra ? 24 : 10 }}>
                    <span style={{ color: C.textMuted, marginRight: 6, fontSize: 11 }}>{r.code}</span>
                    {r.name}
                  </td>
                  <td style={{ ...tdNum, color: isContra ? C.textMuted : C.text }}>
                    {fmtCents(displayBalance)}
                  </td>
                </tr>
              );
            })}
            {options?.extraTrailingRow && (
              <tr>
                <td style={{ ...td, paddingLeft: options.extraTrailingRow.indent ? 24 : 10, fontStyle: "italic", color: C.textSub }}>
                  {options.extraTrailingRow.label}
                </td>
                <td style={{ ...tdNum, fontStyle: "italic", color: C.textSub }}>
                  {fmtCents(options.extraTrailingRow.value)}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr style={{ background: "#111827" }}>
              <td style={{ ...td, fontWeight: 700, color: C.textSub }}>{totalLabel}</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totalValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Balance Sheet</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          basis: <strong>{basis}</strong> · as of <strong>{asOf}</strong>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setBasis("ACCRUAL")}
            style={basis === "ACCRUAL" ? btnSecondaryActive : btnSecondary}
          >
            Accrual
          </button>
          <button
            onClick={() => setBasis("CASH")}
            style={basis === "CASH" ? btnSecondaryActive : btnSecondary}
          >
            Cash
          </button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          As of:
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
          />
        </label>
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            {renderSection("Assets", assetsRows, "TOTAL ASSETS", totalAssetsNet)}
            {renderSection("Liabilities", liabRows, "TOTAL LIABILITIES", totalLiabilities)}
            {renderSection(
              "Equity",
              equityRows,
              "TOTAL EQUITY",
              totalEquityWithCYE,
              { extraTrailingRow: { label: "Current Year Earnings", value: currentYearEarnings } },
            )}
          </div>

          <div style={{ marginTop: 16, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 12, color: C.textMuted }}>
                <strong style={{ color: C.textSub }}>Variance</strong>
                {"  "}= Assets − Liabilities − Equity − Current Year Earnings
                {" "}(should always be $0.00 — the accounting-equation proof)
              </div>
              <div style={{
                fontSize: 16,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: variance === 0 ? C.success : C.danger,
              }}>
                {fmtCents(variance)}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
