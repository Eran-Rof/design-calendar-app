// src/tanda/InternalBudgets.tsx
//
// Tangerine FP&A — Budgeting & budget-vs-actual (mig 20261030000000).
//
// Three things in one panel:
//   1. BUDGET ENTRY — a by-account grid (full-year, or expand to monthly cells)
//      you type a budget into, per named SCENARIO (default / stretch / board…).
//   2. SEED FROM ACTUALS — draft a whole budget from a prior year's actuals ×
//      growth% (annual or monthly grain). No GL posting — planning data only.
//   3. VARIANCE DASHBOARD — budget vs actual by band + the biggest UNFAVOURABLE
//      variances, sign-aware (over-revenue favourable, over-expense not).
//
// Actuals + favourability come from the budget_vs_actual RPC (same signed GL
// semantics as the Income Statement). All amounts are TRUE integer cents.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";
import { isFavorable, varianceCents, variancePct } from "../lib/budget";

const C = { bg: "#0F172A", card: "#1E293B", cardBdr: "#334155", band: "#0b1220", text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid #1f2a3d`, color: C.text, fontSize: 13 };
const input: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const btnP: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnS: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12 };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type VarRow = { account_id: string; code: string; name: string; account_type: string; account_subtype: string | null; parent_code: string | null; parent_name: string | null; month: number; budget_cents: number; actual_cents: number; variance_cents: number; favorable: boolean; variance_pct: number | null };
type BudgetCell = { id: string; gl_account_id: string; account_code: string | null; account_name: string | null; account_type: string | null; fiscal_year: number; period_number: number; amount_cents: number; scenario: string };
type Acct = { id: string; code: string; name: string; account_type: string };

function fmt(cents: number): string {
  const neg = cents < 0; const abs = Math.abs(cents); const whole = Math.trunc(abs / 100); const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}
function fmtPct(v: number | null): string { return v == null ? "—" : `${v.toFixed(1)}%`; }

// Band classification — kept identical to the Income Statement panel so the
// dashboard lines up with the P&L bands the CEO reads.
type BandId = "revenue" | "contra" | "cogs" | "opex" | "other_inc" | "other_exp";
const OPER_5XXX = /(clearing|ticket|shipping)/i;
function classifyBand(accountType: string, code: string, name: string): BandId {
  if (accountType === "revenue") return code < "4900" ? "revenue" : "other_inc";
  if (accountType === "contra_revenue") return "contra";
  if (code >= "5000" && code < "6000" && !OPER_5XXX.test(name)) return "cogs";
  if (code >= "8000") return "other_exp";
  return "opex";
}
const BAND_LABEL: Record<BandId, string> = { revenue: "Revenue", contra: "Returns, Discounts & Chargebacks", cogs: "Cost of Goods Sold", opex: "Operating Expenses", other_inc: "Other Income", other_exp: "Other Expense" };
// Income-like bands where higher actual is favourable.
const BAND_FAV_POSITIVE: Record<BandId, boolean> = { revenue: true, contra: false, cogs: false, opex: false, other_inc: true, other_exp: false };

export default function InternalBudgets() {
  const thisYear = new Date().getUTCFullYear();
  const [fy, setFy] = useState(thisYear);
  const [scenario, setScenario] = useState("default");
  const [scenarios, setScenarios] = useState<string[]>(["default"]);
  const [basis, setBasis] = useState<"ACCRUAL" | "CASH">("ACCRUAL");
  const [view, setView] = useState<"dashboard" | "entry">("dashboard");
  const [showMonthly, setShowMonthly] = useState(false);

  const [variance, setVariance] = useState<VarRow[]>([]);
  const [cells, setCells] = useState<BudgetCell[]>([]);
  const [accounts, setAccounts] = useState<Acct[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Seed + import modal state.
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedSource, setSeedSource] = useState(thisYear - 1);
  const [seedGrowth, setSeedGrowth] = useState("0");
  const [seedGrain, setSeedGrain] = useState<"annual" | "monthly">("annual");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [newScenario, setNewScenario] = useState("");

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`/api/internal/budgets?fiscal_year=${fy}&scenario=${encodeURIComponent(scenario)}&basis=${basis}`).then((x) => x.json());
      setVariance(Array.isArray(r.variance) ? r.variance : []);
      setCells(Array.isArray(r.budgets) ? r.budgets : []);
      if (Array.isArray(r.scenarios) && r.scenarios.length) setScenarios(r.scenarios);
    } catch { /* */ } finally { setLoading(false); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [fy, scenario, basis]);
  useEffect(() => {
    fetch("/api/internal/gl-accounts").then((r) => r.json()).then((j) => {
      const arr = Array.isArray(j) ? j : (Array.isArray(j.accounts) ? j.accounts : []);
      setAccounts(arr
        .map((a: Record<string, unknown>) => ({ id: a.id as string, code: (a.code as string) || "", name: (a.name as string) || "", account_type: (a.account_type as string) || "" }))
        .filter((a: Acct) => ["revenue", "contra_revenue", "expense"].includes(a.account_type)));
    }).catch(() => {});
  }, []);

  // ── Per-account roll-up of the variance grid (sum months) ──────────────────
  type AcctAgg = { account_id: string; code: string; name: string; account_type: string; band: BandId; budget: number; actual: number };
  const perAccount = useMemo(() => {
    const m = new Map<string, AcctAgg>();
    for (const r of variance) {
      let a = m.get(r.account_id);
      if (!a) { a = { account_id: r.account_id, code: r.code, name: r.name, account_type: r.account_type, band: classifyBand(r.account_type, r.code, r.name), budget: 0, actual: 0 }; m.set(r.account_id, a); }
      a.budget += r.budget_cents; a.actual += r.actual_cents;
    }
    return [...m.values()].sort((x, y) => (x.code < y.code ? -1 : 1));
  }, [variance]);

  // Budget-cell lookup for the entry grid: (account_id, period) → amount.
  const cellMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells) m.set(`${c.gl_account_id}:${c.period_number}`, c.amount_cents);
    return m;
  }, [cells]);

  // ── Dashboard aggregations ─────────────────────────────────────────────────
  const byBand = useMemo(() => {
    const b: Record<BandId, { budget: number; actual: number }> = { revenue: { budget: 0, actual: 0 }, contra: { budget: 0, actual: 0 }, cogs: { budget: 0, actual: 0 }, opex: { budget: 0, actual: 0 }, other_inc: { budget: 0, actual: 0 }, other_exp: { budget: 0, actual: 0 } };
    for (const a of perAccount) { b[a.band].budget += a.budget; b[a.band].actual += a.actual; }
    return b;
  }, [perAccount]);

  const netSales = { budget: byBand.revenue.budget - byBand.contra.budget, actual: byBand.revenue.actual - byBand.contra.actual };
  const grossProfit = { budget: netSales.budget - byBand.cogs.budget, actual: netSales.actual - byBand.cogs.actual };
  const netIncome = {
    budget: grossProfit.budget - byBand.opex.budget + byBand.other_inc.budget - byBand.other_exp.budget,
    actual: grossProfit.actual - byBand.opex.actual + byBand.other_inc.actual - byBand.other_exp.actual,
  };

  // Biggest UNFAVOURABLE variances (accounts with a budget set).
  const worst = useMemo(() => {
    return perAccount
      .filter((a) => a.budget !== 0 && !isFavorable(a.account_type, a.actual, a.budget))
      .map((a) => ({ ...a, v: varianceCents(a.actual, a.budget), pct: variancePct(a.actual, a.budget) }))
      .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
      .slice(0, 12);
  }, [perAccount]);

  const anyBudget = perAccount.some((a) => a.budget !== 0);

  // ── Persist a single budget cell ───────────────────────────────────────────
  async function saveCell(accountId: string, period: number, dollars: string) {
    const amount_cents = Math.round((Number(dollars) || 0) * 100);
    setBusy(true);
    try {
      const r = await fetch("/api/internal/budgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gl_account_id: accountId, fiscal_year: fy, period_number: period, amount_cents, scenario }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      await load();
    } catch (e) { notify("Save failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }

  async function runSeed() {
    setBusy(true);
    try {
      const r = await fetch("/api/internal/budgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "seed", source_year: seedSource, target_year: fy, growth_pct: Number(seedGrowth) || 0, grain: seedGrain, basis, scenario }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || "Seeded.", "success"); setSeedOpen(false); await load();
    } catch (e) { notify("Seed failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }

  // Import: paste "code, amount[, period]" lines (period optional, 0 = full-year).
  async function runImport() {
    const byCode = new Map(accounts.map((a) => [a.code.toUpperCase(), a.id]));
    const rows: Array<{ gl_account_id: string; period_number: number; amount_cents: number }> = [];
    const errors: string[] = [];
    for (const raw of importText.split(/\r?\n/)) {
      const line = raw.trim(); if (!line || /^(code|account)/i.test(line)) continue;
      const parts = line.split(/[,\t]/).map((s) => s.trim());
      const code = (parts[0] || "").toUpperCase(); const amt = Number((parts[1] || "").replace(/[$,]/g, "")); const period = Math.round(Number(parts[2] || "0"));
      const id = byCode.get(code);
      if (!id) { errors.push(`Unknown account code: ${parts[0]}`); continue; }
      if (!Number.isFinite(amt)) { errors.push(`Bad amount for ${code}: ${parts[1]}`); continue; }
      if (period < 0 || period > 12) { errors.push(`Bad period for ${code}: ${parts[2]}`); continue; }
      rows.push({ gl_account_id: id, period_number: period, amount_cents: Math.round(amt * 100) });
    }
    if (errors.length) { notify(`${errors.length} line(s) skipped: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? "…" : ""}`, "error"); }
    if (!rows.length) { if (!errors.length) notify("Nothing to import", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/budgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fiscal_year: fy, scenario, rows }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || `Imported ${rows.length}.`, "success"); setImportOpen(false); setImportText(""); await load();
    } catch (e) { notify("Import failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }

  async function clearScenario() {
    if (!(await confirmDialog(`Clear ALL budget rows for scenario "${scenario}" / FY${fy}? This cannot be undone.`))) return;
    setBusy(true);
    try { await fetch(`/api/internal/budgets?all=1&fiscal_year=${fy}&scenario=${encodeURIComponent(scenario)}`, { method: "DELETE" }); notify("Scenario cleared", "success"); await load(); }
    catch (e) { notify(String(e instanceof Error ? e.message : e), "error"); } finally { setBusy(false); }
  }

  // ── Export rows (dashboard by-account) ─────────────────────────────────────
  type ER = { account: string; band: string; budget: number; actual: number; variance: number; favorable: string };
  const exportRows: ER[] = perAccount.map((a) => ({ account: `${a.code} ${a.name}`, band: BAND_LABEL[a.band], budget: a.budget / 100, actual: a.actual / 100, variance: varianceCents(a.actual, a.budget) / 100, favorable: a.budget === 0 ? "" : isFavorable(a.account_type, a.actual, a.budget) ? "Favorable" : "Unfavorable" }));
  const exportCols: ExportColumn<ER>[] = [
    { key: "account", header: "Account" }, { key: "band", header: "Band" },
    { key: "budget", header: "Budget", format: "currency_dollars" }, { key: "actual", header: "Actual", format: "currency_dollars" },
    { key: "variance", header: "Variance", format: "currency_dollars" }, { key: "favorable", header: "Fav/Unfav" },
  ];

  // Scenario options: existing + a new-scenario entry.
  const scenarioOpts = scenarios.map((s) => ({ value: s, label: s, searchHaystack: s }));

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      {/* Header + controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Budgets</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>budget vs actual · sign-aware variance</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ color: C.textMuted, fontSize: 12 }}>FY <input style={{ ...input, width: "7ch" }} value={fy} onChange={(e) => setFy(Number(e.target.value) || thisYear)} /></label>
          <div style={{ minWidth: 170 }}><SearchableSelect options={scenarioOpts} value={scenario} onChange={setScenario} placeholder="Scenario…" /></div>
          <div style={{ display: "flex", border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
            {(["ACCRUAL", "CASH"] as const).map((b) => (
              <button key={b} onClick={() => setBasis(b)} style={{ padding: "6px 12px", background: basis === b ? C.primary : C.card, color: basis === b ? "white" : C.textSub, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{b}</button>
            ))}
          </div>
          <ExportButton rows={exportRows} columns={exportCols} filename={`budget-vs-actual-${scenario}-${fy}`} />
        </div>
      </div>

      {/* Action bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
          {([["dashboard", "Variance dashboard"], ["entry", "Budget entry"]] as const).map(([v, lbl]) => (
            <button key={v} onClick={() => setView(v)} style={{ padding: "6px 14px", background: view === v ? C.primary : C.card, color: view === v ? "white" : C.textSub, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{lbl}</button>
          ))}
        </div>
        <button style={btnS} onClick={() => setSeedOpen(true)}>Seed from actuals…</button>
        <button style={btnS} onClick={() => setImportOpen(true)}>Import (paste)…</button>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input style={{ ...input, width: "16ch" }} placeholder="New scenario name" value={newScenario} onChange={(e) => setNewScenario(e.target.value)} />
          <button style={btnS} disabled={!newScenario.trim()} onClick={() => { const n = newScenario.trim(); if (!n) return; setScenarios((s) => [...new Set([...s, n])].sort()); setScenario(n); setNewScenario(""); }}>+ Add</button>
        </div>
        <button style={{ ...btnS, color: C.danger, marginLeft: "auto" }} disabled={busy} onClick={clearScenario}>Clear scenario</button>
      </div>

      {loading ? <div style={{ color: C.textMuted, padding: 20 }}>Loading…</div> : view === "dashboard" ? (
        <DashboardView byBand={byBand} netSales={netSales} grossProfit={grossProfit} netIncome={netIncome} worst={worst} anyBudget={anyBudget} />
      ) : (
        <EntryGrid accounts={accounts} cellMap={cellMap} perAccount={perAccount} showMonthly={showMonthly} setShowMonthly={setShowMonthly} saveCell={saveCell} busy={busy} />
      )}

      {/* Seed modal */}
      {seedOpen && (
        <Modal title="Seed budget from prior-year actuals" onClose={() => setSeedOpen(false)}>
          <p style={{ color: C.textSub, fontSize: 13, marginTop: 0 }}>Draft the FY{fy} <strong>{scenario}</strong> budget from a source year's posted actuals × a growth factor. This overwrites existing cells for the matching accounts/periods. No GL is posted.</p>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, alignItems: "center" }}>
            <label style={{ color: C.textMuted, fontSize: 13 }}>Source year</label>
            <input style={{ ...input, width: "10ch" }} value={seedSource} onChange={(e) => setSeedSource(Number(e.target.value) || thisYear - 1)} />
            <label style={{ color: C.textMuted, fontSize: 13 }}>Growth %</label>
            <input style={{ ...input, width: "10ch" }} value={seedGrowth} onChange={(e) => setSeedGrowth(e.target.value)} placeholder="e.g. 5 or -3" />
            <label style={{ color: C.textMuted, fontSize: 13 }}>Grain</label>
            <div style={{ display: "flex", border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden", width: "fit-content" }}>
              {([["annual", "Full-year"], ["monthly", "Monthly"]] as const).map(([v, lbl]) => (
                <button key={v} onClick={() => setSeedGrain(v)} style={{ padding: "6px 12px", background: seedGrain === v ? C.primary : C.card, color: seedGrain === v ? "white" : C.textSub, border: "none", cursor: "pointer", fontSize: 12 }}>{lbl}</button>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button style={btnS} onClick={() => setSeedOpen(false)}>Cancel</button>
            <button style={btnP} disabled={busy} onClick={runSeed}>Seed budget</button>
          </div>
        </Modal>
      )}

      {/* Import modal */}
      {importOpen && (
        <Modal title="Import budget (paste)" onClose={() => setImportOpen(false)}>
          <p style={{ color: C.textSub, fontSize: 13, marginTop: 0 }}>One line per cell: <code style={{ color: C.text }}>account_code, amount[, period]</code>. Period is optional (0 or blank = full-year; 1–12 = a month). CSV or tab-separated. Amounts in dollars.</p>
          <textarea style={{ ...input, width: "100%", minHeight: 180, fontFamily: "monospace", resize: "vertical" }} placeholder={"4005, 1200000\n5010, 750000, 1\n6100, 45000"} value={importText} onChange={(e) => setImportText(e.target.value)} />
          <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button style={btnS} onClick={() => setImportOpen(false)}>Cancel</button>
            <button style={btnP} disabled={busy || !importText.trim()} onClick={runImport}>Import</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Variance dashboard ───────────────────────────────────────────────────────
function DashboardView({ byBand, netSales, grossProfit, netIncome, worst, anyBudget }: {
  byBand: Record<BandId, { budget: number; actual: number }>;
  netSales: { budget: number; actual: number }; grossProfit: { budget: number; actual: number }; netIncome: { budget: number; actual: number };
  worst: Array<{ account_id: string; code: string; name: string; band: BandId; v: number; pct: number | null; budget: number; actual: number }>;
  anyBudget: boolean;
}) {
  const tile = (label: string, budget: number, actual: number, favPos: boolean) => {
    const v = varianceCents(actual, budget); const fav = favPos ? v >= 0 : v <= 0;
    return (
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 14px", minWidth: 190, flex: "1 1 190px" }}>
        <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
        <div style={{ fontSize: 19, fontWeight: 700, marginTop: 4 }}>{fmt(actual)}</div>
        <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>Budget {fmt(budget)}</div>
        <div style={{ color: budget === 0 ? C.textMuted : fav ? C.success : C.danger, fontSize: 12, fontWeight: 600, marginTop: 3 }}>
          {budget === 0 ? "no budget" : `${fmt(v)} · ${fmtPct(variancePct(actual, budget))} ${fav ? "▲ favorable" : "▼ unfavorable"}`}
        </div>
      </div>
    );
  };
  const bandRows: BandId[] = ["revenue", "contra", "cogs", "opex", "other_inc", "other_exp"];
  return (
    <div>
      {!anyBudget && <div style={{ background: "#1e293b", border: `1px solid ${C.warn}`, color: C.textSub, borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>No budget entered yet for this scenario. Use <strong>Seed from actuals</strong> or <strong>Budget entry</strong> to load one — the columns below then show variance against it.</div>}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        {tile("Net Sales", netSales.budget, netSales.actual, true)}
        {tile("Gross Profit", grossProfit.budget, grossProfit.actual, true)}
        {tile("Operating Expenses", byBand.opex.budget, byBand.opex.actual, false)}
        {tile("Net Income", netIncome.budget, netIncome.actual, true)}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* By band */}
        <div style={{ flex: "1 1 420px", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "9px 12px", background: C.band, fontWeight: 600, fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>Budget vs actual by band</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Band</th><th style={{ ...th, textAlign: "right" }}>Budget</th><th style={{ ...th, textAlign: "right" }}>Actual</th><th style={{ ...th, textAlign: "right" }}>Variance</th></tr></thead>
            <tbody>
              {bandRows.map((b) => {
                const row = byBand[b]; if (row.budget === 0 && row.actual === 0) return null;
                const v = varianceCents(row.actual, row.budget); const fav = BAND_FAV_POSITIVE[b] ? v >= 0 : v <= 0;
                return (
                  <tr key={b}>
                    <td style={td}>{BAND_LABEL[b]}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(row.budget)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(row.actual)}</td>
                    <td style={{ ...td, textAlign: "right", color: row.budget === 0 ? C.textMuted : fav ? C.success : C.danger, fontWeight: 600 }}>{fmt(v)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Biggest unfavourable */}
        <div style={{ flex: "1 1 420px", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "9px 12px", background: C.band, fontWeight: 600, fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>Biggest unfavorable variances</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Account</th><th style={{ ...th, textAlign: "right" }}>Variance</th><th style={{ ...th, textAlign: "right" }}>%</th></tr></thead>
            <tbody>
              {worst.length === 0 && <tr><td style={{ ...td, color: C.textMuted, textAlign: "center", padding: 22 }} colSpan={3}>No unfavorable variances.</td></tr>}
              {worst.map((w) => (
                <tr key={w.account_id}>
                  <td style={{ ...td, color: C.primary }}>{w.code} {w.name}</td>
                  <td style={{ ...td, textAlign: "right", color: C.danger, fontWeight: 600 }}>{fmt(w.v)}</td>
                  <td style={{ ...td, textAlign: "right", color: C.textMuted }}>{fmtPct(w.pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Budget entry grid ────────────────────────────────────────────────────────
function EntryGrid({ accounts, cellMap, perAccount, showMonthly, setShowMonthly, saveCell, busy }: {
  accounts: Acct[]; cellMap: Map<string, number>;
  perAccount: Array<{ account_id: string; code: string; name: string; account_type: string; budget: number; actual: number }>;
  showMonthly: boolean; setShowMonthly: (v: boolean) => void;
  saveCell: (accountId: string, period: number, dollars: string) => void; busy: boolean;
}) {
  const actualByAccount = useMemo(() => { const m = new Map<string, number>(); for (const a of perAccount) m.set(a.account_id, a.actual); return m; }, [perAccount]);
  const dollars = (cents: number) => (cents / 100).toFixed(2);
  const cell = (accountId: string, period: number) => {
    const v = cellMap.get(`${accountId}:${period}`);
    return (
      <input defaultValue={v == null ? "" : dollars(v)} key={`${accountId}:${period}:${v ?? ""}`}
        onBlur={(e) => { const nv = e.target.value.trim(); const cur = v == null ? "" : dollars(v); if (nv !== cur) saveCell(accountId, period, nv || "0"); }}
        disabled={busy} placeholder="0.00"
        style={{ ...input, width: showMonthly ? "9ch" : "12ch", textAlign: "right", padding: "4px 6px" }} />
    );
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={showMonthly} onChange={(e) => setShowMonthly(e.target.checked)} /> Monthly cells (Jan–Dec)
        </label>
        <span style={{ color: C.textMuted, fontSize: 12 }}>Type a budget and tab out to save. {showMonthly ? "Each month is a separate budget cell." : "Full-year budget (spread evenly across 12 months for monthly reports)."}</span>
      </div>
      <div style={{ overflow: "auto", maxHeight: "calc(100vh - 300px)", border: `1px solid ${C.cardBdr}`, borderRadius: 8, background: C.card }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, minWidth: 220 }}>Account</th>
              {showMonthly ? MONTHS.map((m, i) => <th key={i} style={{ ...th, textAlign: "right" }}>{m}</th>)
                : <th style={{ ...th, textAlign: "right" }}>Budget (FY)</th>}
              <th style={{ ...th, textAlign: "right" }}>Actual</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && <tr><td style={{ ...td, color: C.textMuted, textAlign: "center", padding: 24 }} colSpan={showMonthly ? 14 : 3}>No P&amp;L accounts found.</td></tr>}
            {accounts.map((a) => (
              <tr key={a.id}>
                <td style={{ ...td, whiteSpace: "nowrap" }}><span style={{ color: C.textMuted, marginRight: 6 }}>{a.code}</span>{a.name}</td>
                {showMonthly ? Array.from({ length: 12 }, (_, i) => <td key={i} style={{ ...td, textAlign: "right", padding: "3px 4px" }}>{cell(a.id, i + 1)}</td>)
                  : <td style={{ ...td, textAlign: "right" }}>{cell(a.id, 0)}</td>}
                <td style={{ ...td, textAlign: "right", color: C.textMuted }}>{fmt(actualByAccount.get(a.id) || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Responsive modal (min(cap,95vw) / 90vh, frozen footer via flex) ──────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 95vw)", maxHeight: "90vh", overflow: "auto", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, padding: 20, color: C.text }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
          <button onClick={onClose} style={{ background: "transparent", border: 0, color: C.textMuted, fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
