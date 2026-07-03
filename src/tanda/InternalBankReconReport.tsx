// src/tanda/InternalBankReconReport.tsx
//
// Tangerine P6-6 — Bank Reconciliation Report panel.
//
// Per-account, per-period reconciliation:
//   1. Operator picks the period.
//   2. Per active bank_account, panel either fetches/creates a
//      bank_recon_runs row (POST /api/internal/bank-recon-runs).
//   3. Operator types the bank-statement-end balance + clicks
//      "Compute" → backend recomputes gl_balance + uncleared + diff.
//   4. If diff = $0.00, "Mark Reconciled" button enables.
//   5. Once all active bank accounts are 'reconciled', the period-close
//      pre-flight (P6-6 extension) passes the bank_recon_complete check.

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import SearchableSelect from "./components/SearchableSelect";
import { fmtDateDisplay } from "../utils/tandaTypes";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

const TABLE_KEY = "tanda.bank_recon_report";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "account",        label: "Account" },
  { key: "gl_balance",     label: "GL Balance" },
  { key: "uncleared",      label: "+ Uncleared" },
  { key: "bank_statement", label: "Bank Statement" },
  { key: "diff",           label: "Diff" },
  { key: "status",         label: "Status" },
];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type Period = {
  id: string;
  fiscal_year: number;
  period_number: number;
  starts_on: string;
  ends_on: string;
  status: string;
};
type BankAccount = {
  id: string;
  name: string;
  mask: string | null;
  is_active: boolean;
};
type ReconRun = {
  id: string;
  bank_account_id: string;
  period_id: string;
  bank_statement_balance_cents: number | null;
  gl_balance_cents: number | null;
  uncleared_txn_cents: number | null;
  reconciled_diff_cents: number | null;
  status: "in_progress" | "reconciled" | "flagged";
  notes: string | null;
  reconciled_at: string | null;
  bank_accounts: { name: string; mask: string | null };
  gl_periods: { fiscal_year: number; period_number: number; starts_on: string; ends_on: string };
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "6px 12px",
  borderRadius: 4, cursor: "pointer", fontSize: 12, marginRight: 4,
};
const btnSuccess: React.CSSProperties = { ...btnPrimary, background: C.success };
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontSize: 12, marginRight: 4,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function fmtCents(c: number | null | undefined): string {
  if (c == null) return "—";
  const n = Number(c);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

export default function InternalBankReconReport() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [periodId, setPeriodId] = useState("");
  const [runs, setRuns] = useState<ReconRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});       // bank_account_id -> typed statement balance (dollars)
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function loadBase() {
    setLoading(true);
    try {
      const [pResp, aResp] = await Promise.all([
        fetch(`/api/internal/gl-periods?fiscal_year=${new Date().getUTCFullYear()}`),
        fetch(`/api/internal/bank-accounts`),
      ]);
      if (pResp.ok) setPeriods((await pResp.json() as Period[]).sort((x, y) => x.period_number - y.period_number));
      if (aResp.ok) setAccounts((await aResp.json() as BankAccount[]).filter((a) => a.is_active));
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadBase(); }, []);

  async function loadRuns() {
    if (!periodId) return;
    setLoading(true); setErr(null);
    try {
      // Ensure a run exists for every active bank account in this period.
      await Promise.all(
        accounts.map((a) =>
          fetch(`/api/internal/bank-recon-runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bank_account_id: a.id, period_id: periodId }),
          }),
        ),
      );
      const r = await fetch(`/api/internal/bank-recon-runs?period_id=${periodId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRuns(await r.json() as ReconRun[]);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (periodId) void loadRuns(); }, [periodId]);

  async function saveStatementBalance(run: ReconRun) {
    const raw = editing[run.bank_account_id];
    if (raw == null || raw === "") return;
    const dollars = parseFloat(raw);
    if (!Number.isFinite(dollars)) { notify("Invalid amount", "error"); return; }
    const cents = Math.round(dollars * 100);
    try {
      const r = await fetch(`/api/internal/bank-recon-runs/${run.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bank_statement_balance_cents: cents }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); notify(`Save failed: ${e.error}`, "error"); return; }
      setEditing((p) => { const c = { ...p }; delete c[run.bank_account_id]; return c; });
      await loadRuns();
    } catch (e: unknown) { notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }

  async function recompute(run: ReconRun) {
    try {
      const r = await fetch(`/api/internal/bank-recon-runs/${run.id}/compute`, { method: "POST" });
      if (!r.ok) { const e = await r.json().catch(() => ({})); notify(`Compute failed: ${e.error}`, "error"); return; }
      await loadRuns();
    } catch (e: unknown) { notify(`Compute failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }

  async function markReconciled(run: ReconRun) {
    if (!(await confirmDialog("Mark this bank account reconciled for this period? Requires diff = $0.00."))) return;
    try {
      const r = await fetch(`/api/internal/bank-recon-runs/${run.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "reconciled" }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); notify(`Reconcile failed: ${e.error}`, "error"); return; }
      await loadRuns();
    } catch (e: unknown) { notify(`Reconcile failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }

  async function reopenRun(run: ReconRun) {
    if (!(await confirmDialog("Reopen this reconciliation? Status goes back to in_progress."))) return;
    try {
      const r = await fetch(`/api/internal/bank-recon-runs/${run.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); notify(`Reopen failed: ${e.error}`, "error"); return; }
      await loadRuns();
    } catch (e: unknown) { notify(`Reopen failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }

  const reconciledCount = useMemo(() => runs.filter((r) => r.status === "reconciled").length, [runs]);

  // Export rows mirror the displayed recon table — account label resolved,
  // cents kept in cents for currency formatting.
  const exportRows = useMemo(
    () =>
      runs.map((r) => ({
        account: `${r.bank_accounts.name}${r.bank_accounts.mask ? ` ••${r.bank_accounts.mask}` : ""}`,
        gl_balance_cents: r.gl_balance_cents,
        uncleared_cents: r.uncleared_txn_cents,
        bank_statement_cents: r.bank_statement_balance_cents,
        diff_cents: r.reconciled_diff_cents,
        status: r.status,
        reconciled_at: r.reconciled_at || "",
      })),
    [runs],
  );
  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: "account",              header: "Account" },
    { key: "gl_balance_cents",     header: "GL Balance", format: "currency_cents" },
    { key: "uncleared_cents",      header: "+ Uncleared", format: "currency_cents" },
    { key: "bank_statement_cents", header: "Bank Statement", format: "currency_cents" },
    { key: "diff_cents",           header: "Diff", format: "currency_cents" },
    { key: "status",               header: "Status" },
    { key: "reconciled_at",        header: "Reconciled At", format: "date" },
  ];

  return (
    <div style={{ color: C.text }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Bank Reconciliation Report</h2>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>Period</div>
          <SearchableSelect
            value={periodId || null}
            onChange={(v) => setPeriodId(v)}
            options={[
              { value: "", label: "— pick a period —" },
              ...periods.map((p) => ({
                value: p.id,
                label: `FY${p.fiscal_year} P${String(p.period_number).padStart(2, "0")} · ${p.starts_on} → ${p.ends_on} · ${p.status}`,
              })),
            ]}
            placeholder="— pick a period —"
            inputStyle={inputStyle}
          />
        </div>
        {periodId && (
          <div style={{ fontSize: 13, color: C.textSub }}>
            {reconciledCount} of {accounts.length} accounts reconciled
          </div>
        )}
        {periodId && <button style={btnSecondary} onClick={() => void loadRuns()}>Refresh</button>}
        {periodId && (
          <TablePrefsButton
            tableKey={TABLE_KEY}
            columns={ALL_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
            onSetAll={setAllVisible}
          />
        )}
        {periodId && runs.length > 0 && (
          <ExportButton rows={exportRows} filename="bank-reconciliation" sheetName="Bank Reconciliation" columns={exportColumns} />
        )}
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>{err}</div>}

      {!periodId ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 24, color: C.textMuted, textAlign: "center" }}>
          Pick a period to reconcile.
        </div>
      ) : loading ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 24, color: C.textMuted, textAlign: "center" }}>
          Loading…
        </div>
      ) : runs.length === 0 ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 24, color: C.textMuted, textAlign: "center" }}>
          No active bank accounts. Link one via Bank Reconciliation → Accounts tab.
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th} hidden={!visibleColumns.has("account")}>Account</th>
              <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("gl_balance")}>GL Balance</th>
              <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("uncleared")}>+ Uncleared</th>
              <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("bank_statement")}>Bank Statement</th>
              <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("diff")}>Diff</th>
              <th style={th} hidden={!visibleColumns.has("status")}>Status</th>
              <th style={{ ...th, width: 280 }}>Actions</th>
            </tr></thead>
            <tbody>
              {runs.map((r) => {
                const isReconciled = r.status === "reconciled";
                const diff = r.reconciled_diff_cents;
                const diffColor = diff == null ? C.textMuted : Math.abs(Number(diff)) <= 1 ? C.success : C.danger;
                return (
                  <tr key={r.id}>
                    <td style={td} hidden={!visibleColumns.has("account")}>
                      <strong>{r.bank_accounts.name}</strong>
                      {r.bank_accounts.mask && <span style={{ color: C.textMuted, marginLeft: 6, fontSize: 11 }}>••{r.bank_accounts.mask}</span>}
                    </td>
                    <td style={tdNum} hidden={!visibleColumns.has("gl_balance")}>{fmtCents(r.gl_balance_cents)}</td>
                    <td style={tdNum} hidden={!visibleColumns.has("uncleared")}>{fmtCents(r.uncleared_txn_cents)}</td>
                    <td style={tdNum} hidden={!visibleColumns.has("bank_statement")}>
                      {isReconciled ? (
                        <span>{fmtCents(r.bank_statement_balance_cents)}</span>
                      ) : (
                        <span style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                          <input
                            type="number"
                            step="0.01"
                            placeholder={r.bank_statement_balance_cents != null ? (Number(r.bank_statement_balance_cents) / 100).toFixed(2) : "0.00"}
                            value={editing[r.bank_account_id] ?? ""}
                            onChange={(e) => setEditing((p) => ({ ...p, [r.bank_account_id]: e.target.value }))}
                            style={{ ...inputStyle, width: 110, textAlign: "right" }}
                          />
                          <button style={btnSecondary} onClick={() => void saveStatementBalance(r)}>Set</button>
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdNum, color: diffColor, fontWeight: 700 }} hidden={!visibleColumns.has("diff")}>{fmtCents(diff)}</td>
                    <td style={{ ...td, color: isReconciled ? C.success : r.status === "flagged" ? C.danger : C.warn, fontWeight: 600 }} hidden={!visibleColumns.has("status")}>
                      ● {r.status}
                    </td>
                    <td style={td}>
                      {!isReconciled && (
                        <>
                          <button style={btnSecondary} onClick={() => void recompute(r)}>Recompute</button>
                          <button
                            style={btnSuccess}
                            disabled={diff == null || Math.abs(Number(diff)) > 1}
                            onClick={() => void markReconciled(r)}
                          >
                            Mark Reconciled
                          </button>
                        </>
                      )}
                      {isReconciled && (
                        <>
                          <span style={{ fontSize: 11, color: C.textMuted, marginRight: 8 }}>
                            ✓ {r.reconciled_at ? fmtDateDisplay(r.reconciled_at) : ""}
                          </span>
                          <button style={btnSecondary} onClick={() => void reopenRun(r)}>Reopen</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
