// src/tanda/InternalBudgets.tsx
//
// P25 / M22 — GL budgets + budget-vs-actual. Enter a budget per account (full
// year or a period), and see it next to the actual GL balance (variance).

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";

const C = { bg: "#0F172A", card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const input: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const btnP: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnS: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "4px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12 };

type Budget = { id: string; gl_account_id: string; account_code: string | null; account_name: string | null; account_type: string | null; fiscal_year: number; period_number: number; amount_cents: number; actual_cents: number | null };
type Acct = { id: string; code: string; name: string };

export default function InternalBudgets() {
  const thisYear = 2026;
  const [fy, setFy] = useState(thisYear);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [accounts, setAccounts] = useState<Acct[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [acctId, setAcctId] = useState("");
  const [amount, setAmount] = useState("");

  async function load() {
    setLoading(true);
    try { const r = await fetch(`/api/internal/budgets?fiscal_year=${fy}`).then((x) => x.json()); setBudgets(Array.isArray(r.budgets) ? r.budgets : []); } catch { /* */ } finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [fy]);
  useEffect(() => {
    fetch("/api/internal/gl-accounts").then((r) => r.json()).then((j) => {
      const arr = Array.isArray(j) ? j : (Array.isArray(j.accounts) ? j.accounts : []);
      setAccounts(arr.map((a: Record<string, unknown>) => ({ id: a.id as string, code: (a.code as string) || "", name: (a.name as string) || "" })));
    }).catch(() => {});
  }, []);

  const acctName = useMemo(() => new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`])), [accounts]);

  async function save() {
    if (!acctId) { notify("Pick an account", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/budgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gl_account_id: acctId, fiscal_year: fy, period_number: 0, amount_cents: Math.round((Number(amount) || 0) * 100) }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      notify("Budget saved", "success"); setAcctId(""); setAmount(""); await load();
    } catch (e) { notify("Failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }
  async function del(b: Budget) {
    if (!(await confirmDialog(`Remove the budget for ${b.account_code} ${b.account_name}?`))) return;
    setBusy(true);
    try { await fetch(`/api/internal/budgets?id=${b.id}`, { method: "DELETE" }); await load(); } catch (e) { notify(String(e instanceof Error ? e.message : e), "error"); } finally { setBusy(false); }
  }
  const variance = (b: Budget) => b.actual_cents == null ? null : b.amount_cents - b.actual_cents;

  type ER = { account: string; year: number; budget: number; actual: number | string; variance: number | string };
  const rows: ER[] = budgets.map((b) => ({ account: `${b.account_code || ""} ${b.account_name || ""}`.trim(), year: b.fiscal_year, budget: b.amount_cents / 100, actual: b.actual_cents == null ? "" : b.actual_cents / 100, variance: variance(b) == null ? "" : (variance(b) as number) / 100 }));
  const cols: ExportColumn<ER>[] = [{ key: "account", header: "Account" }, { key: "year", header: "FY", format: "number" }, { key: "budget", header: "Budget", format: "currency_dollars" }, { key: "actual", header: "Actual", format: "currency_dollars" }, { key: "variance", header: "Variance", format: "currency_dollars" }];

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Budgets</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>budget vs actual by account</span>
        <label style={{ color: C.textMuted, fontSize: 12, marginLeft: 10 }}>FY <input style={{ ...input, width: "8ch" }} value={fy} onChange={(e) => setFy(Number(e.target.value) || thisYear)} /></label>
        <div style={{ marginLeft: "auto" }}><ExportButton rows={rows} columns={cols} filename={`budgets-${fy}`} /></div>
      </div>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: C.textMuted, fontSize: 12 }}>Set budget:</span>
        <div style={{ minWidth: 280 }}><SearchableSelect options={accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}`, searchHaystack: `${a.code} ${a.name}` }))} value={acctId} onChange={setAcctId} placeholder="Account…" /></div>
        <input style={{ ...input, width: "12ch", textAlign: "right" }} placeholder="Amount $" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button style={btnP} disabled={busy} onClick={save}>Save (full-year)</button>
      </div>
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Account</th><th style={{ ...th, textAlign: "right" }}>Budget</th><th style={{ ...th, textAlign: "right" }}>Actual</th><th style={{ ...th, textAlign: "right" }}>Variance</th><th style={th}></th></tr></thead>
          <tbody>
            {budgets.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={5}>No budgets for FY{fy}.</td></tr>}
            {budgets.map((b) => { const v = variance(b); return (
              <tr key={b.id}>
                <td style={td}>{b.account_code} {b.account_name}{b.period_number ? <span style={{ color: C.textMuted, fontSize: 11 }}> · P{b.period_number}</span> : ""}</td>
                <td style={{ ...td, textAlign: "right" }}>${(b.amount_cents / 100).toFixed(2)}</td>
                <td style={{ ...td, textAlign: "right", color: C.textMuted }}>{b.actual_cents == null ? "—" : `$${(b.actual_cents / 100).toFixed(2)}`}</td>
                <td style={{ ...td, textAlign: "right", color: v == null ? C.textMuted : v >= 0 ? C.success : C.danger }}>{v == null ? "—" : `$${(v / 100).toFixed(2)}`}</td>
                <td style={td}><button style={{ ...btnS, color: C.danger }} disabled={busy} onClick={() => del(b)}>×</button></td>
              </tr>
            ); })}
          </tbody>
        </table>
        </div>
      )}
      <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>Actuals come from the GL balance view (read $0 until transactions post). Variance = budget − actual.</div>
    </div>
  );
}
