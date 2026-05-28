// src/tanda/InternalYearEndClose.tsx
//
// Tangerine P5-6 — Year-End Close admin panel.
//
// Operator workflow:
//   1. Pick the fiscal year.
//   2. Click **Dry Run** — shows the projected closing JE shape +
//      net-income totals per basis. NO database writes.
//   3. If the numbers look right, uncheck Dry Run + confirm the prompt
//      to commit live. The RPC posts the closing JE + flips all 12
//      periods of that FY to `closed_with_closing_jes` (terminal —
//      cannot be reopened).
//   4. Operator's accountant verifies via the Trial Balance + Balance
//      Sheet reports: post-close, the IS over the closed FY shows $0
//      (revenue + expense zeroed), and the BS shows Retained Earnings
//      bumped by net income.

import { useState } from "react";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type BasisBreakdown = {
  net_income_cents: number;
  line_count: number;
  projected_lines: Array<{ code: string; name: string; side: "DR" | "CR"; amount_cents: number }>;
  skipped_reason?: string;
};

type CloseResult = {
  entity_id: string;
  fiscal_year: number;
  dry_run: boolean;
  accrual_je_id: string | null;
  cash_je_id: string | null;
  periods_flipped: number;
  basis_breakdown: { ACCRUAL?: BasisBreakdown; CASH?: BasisBreakdown };
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnDanger: React.CSSProperties = {
  background: C.danger, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
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
  textAlign: "left", padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

function fmtCents(n: number | null | undefined): string {
  if (n == null) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

export default function InternalYearEndClose() {
  const currentYear = new Date().getUTCFullYear();
  const [fiscalYear, setFiscalYear] = useState<number>(currentYear - 1);
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);

  async function run() {
    if (!dryRun) {
      const proceed = confirm(
        `LIVE RUN: post the year-end closing JE for FY ${fiscalYear} and flip ALL 12 periods to closed_with_closing_jes (TERMINAL — cannot be reopened). Continue?`,
      );
      if (!proceed) return;
    }
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const r = await fetch(`/api/internal/year-end-close/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fiscal_year: fiscalYear, dry_run: dryRun }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setResult(data as CloseResult);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Year-End Close</h2>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: C.textSub, marginBottom: 12 }}>
          Posts the closing JE for both ACCRUAL and CASH books: zero revenue +
          expense accounts; credit/debit retained earnings by net income/loss.
          Flips all 12 periods of the FY to <code>closed_with_closing_jes</code>
          (<strong>terminal</strong> — cannot be reopened). One-shot per FY.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "end" }}>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>Fiscal Year</div>
            <input
              type="number"
              min={2024}
              max={2099}
              value={fiscalYear}
              onChange={(e) => setFiscalYear(parseInt(e.target.value, 10) || currentYear - 1)}
              style={inputStyle}
            />
          </div>
          <div style={{ alignSelf: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.textSub }}>
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Dry Run (preview only — no DB writes)
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => void run()}
              style={dryRun ? btnPrimary : btnDanger}
              disabled={running}
            >
              {running ? "Running…" : dryRun ? "Preview close" : "POST closing JE"}
            </button>
          </div>
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            Error: {err}
          </div>
        )}
      </div>

      {result && (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 13, color: C.textSub, marginBottom: 12 }}>
            {result.dry_run ? "DRY RUN preview" : "LIVE RUN result"} — FY {result.fiscal_year}
            {!result.dry_run && (
              <span style={{ marginLeft: 8, fontSize: 11, color: C.success }}>
                ✓ {result.periods_flipped} periods flipped to terminal
              </span>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 12, marginBottom: 16 }}>
            <div>
              <div style={{ color: C.textMuted, marginBottom: 4 }}>Accrual JE</div>
              <div style={{ fontFamily: "monospace", color: result.accrual_je_id ? C.text : C.textMuted }}>
                {result.accrual_je_id || "(no JE — no revenue/expense activity)"}
              </div>
            </div>
            <div>
              <div style={{ color: C.textMuted, marginBottom: 4 }}>Cash JE (sibling)</div>
              <div style={{ fontFamily: "monospace", color: result.cash_je_id ? C.text : C.textMuted }}>
                {result.cash_je_id || "(no JE — no revenue/expense activity)"}
              </div>
            </div>
          </div>

          {(["ACCRUAL", "CASH"] as const).map((basis) => {
            const b = result.basis_breakdown[basis];
            if (!b) return null;
            const ni = b.net_income_cents;
            const niLabel = ni > 0 ? `Net income ${fmtCents(ni)}` : ni < 0 ? `Net loss ${fmtCents(Math.abs(ni))}` : "No activity";
            return (
              <div key={basis} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textSub }}>{basis} book</div>
                  <div style={{ fontSize: 12, color: ni > 0 ? C.success : ni < 0 ? C.danger : C.textMuted }}>{niLabel}</div>
                </div>
                {b.skipped_reason ? (
                  <div style={{ padding: "8px 10px", color: C.textMuted, fontStyle: "italic", fontSize: 12 }}>
                    {b.skipped_reason}
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={th}>Code</th>
                        <th style={th}>Name</th>
                        <th style={th}>Side</th>
                        <th style={{ ...th, textAlign: "right" }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(b.projected_lines || []).map((ln, i) => (
                        <tr key={i}>
                          <td style={{ ...td, fontFamily: "monospace" }}>{ln.code}</td>
                          <td style={td}>{ln.name}</td>
                          <td style={{ ...td, color: ln.side === "DR" ? C.primary : C.warn, fontWeight: 600 }}>{ln.side}</td>
                          <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(ln.amount_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
