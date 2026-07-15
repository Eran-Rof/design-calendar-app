// src/tanda/InternalConsolidation.tsx
//
// Multi-entity Consolidation panel (#NNNN).
//
// Consolidated financials across the members of a consolidation group
// (default "ROF Consolidated" = ROF + SAG), presented with a BY-ENTITY column
// view: one column per member entity, an Eliminations column, and a
// Consolidated column (= Σ entities + eliminations).
//
// Consolidation is a pure reporting layer over each entity's GL (a faithful
// Xoro mirror). Intercompany eliminations are config-driven reporting
// adjustments (account pairs) — never GL postings. SAG is dormant today, so
// consolidated == ROF standalone until SAG posts activity.
//
// Statements: Trial Balance / Income Statement / Balance Sheet. Click any line
// to drill into each entity's contribution → that entity's GL detail. The
// Eliminations tab manages the intercompany rules.

import { useEffect, useMemo, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import { notify, confirmDialog } from "../shared/ui/warn";
import DateRangePresets from "./components/DateRangePresets.tsx";
import GLDetailModal, { type GLDetailTarget } from "./components/GLDetailModal";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import {
  pivotTrialBalance, pivotIncomeStatement, pivotBalanceSheet,
  incomeStatementNetIncome, lineColumnValue,
  ELIM_KEY, CONSOLIDATED_KEY,
  type ConsolTbRow, type ConsolIsRow, type ConsolBsRow,
  type PivotResult, type PivotLine,
} from "../lib/consolidation";

type Basis = "ACCRUAL" | "CASH";
type Tab = "tb" | "is" | "bs";

interface MemberEntity { entity_id: string; entity_code: string; entity_name: string; }
interface GroupInfo {
  id: string; code: string; name: string; description?: string | null;
  members: MemberEntity[]; active_rule_count: number;
}
interface ElimRule {
  id: string; rule_code: string; rule_name: string; reason: string;
  amount_method: string; fixed_amount_cents: number | null; is_active: boolean;
  debit_entity: string | null; debit_account: { code: string; name: string } | null;
  credit_entity: string | null; credit_account: { code: string; name: string } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  inputBg: "#0b1220", head: "#0b1220",
};

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnSecondaryActive: React.CSSProperties = { ...btnSecondary, background: C.primary, color: "#fff", borderColor: C.primary };
const btnPrimary: React.CSSProperties = { ...btnSecondary, background: C.primary, color: "#fff", borderColor: C.primary };
const inputStyle: React.CSSProperties = {
  background: C.inputBg, color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const selectStyle: React.CSSProperties = { ...inputStyle };
const th: React.CSSProperties = {
  background: C.head, color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2,
};
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  const neg = n < 0; const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100); const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}
function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function yearStartISO(iso: string): string { return `${iso.slice(0, 4)}-01-01`; }

export default function InternalConsolidation() {
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [groupId, setGroupId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("tb");
  const [basis, setBasis] = useState<Basis>("ACCRUAL");
  const [from, setFrom] = useState<string>(yearStartISO(todayISO()));
  const [to, setTo] = useState<string>(todayISO());
  const [asOf, setAsOf] = useState<string>(todayISO());

  const [rawRows, setRawRows] = useState<Array<ConsolTbRow | ConsolIsRow | ConsolBsRow>>([]);
  const [entities, setEntities] = useState<MemberEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [drill, setDrill] = useState<GLDetailTarget | null>(null);
  const [contribLine, setContribLine] = useState<PivotLine | null>(null);
  const [showElim, setShowElim] = useState(false);

  const group = useMemo(() => groups.find((g) => g.id === groupId) || null, [groups, groupId]);
  const seqGuard = useSeqGuard();

  // ── Load groups once ────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/internal/consolidation/groups");
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        const gs: GroupInfo[] = d.groups || [];
        setGroups(gs);
        if (gs.length && !groupId) setGroupId(gs[0].id);
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load the active statement ───────────────────────────────────────────────
  async function load() {
    if (!groupId) return;
    const seq = seqGuard.begin();
    setLoading(true); setErr(null);
    try {
      let url: string;
      if (tab === "bs") {
        url = `/api/internal/consolidation/balance-sheet?group=${groupId}&basis=${basis}&as_of=${asOf}`;
      } else {
        const path = tab === "tb" ? "trial-balance" : "income-statement";
        url = `/api/internal/consolidation/${path}?group=${groupId}&basis=${basis}&from=${from}&to=${to}`;
      }
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (!seqGuard.isCurrent(seq)) return;
      setRawRows(d.rows || []);
      setEntities(d.entities || []);
    } catch (e) {
      if (seqGuard.isCurrent(seq)) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [groupId, tab, basis, from, to, asOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const entityCodes = useMemo(() => entities.map((e) => e.entity_code), [entities]);

  // Pivot per statement.
  const pivot: PivotResult = useMemo(() => {
    if (tab === "tb") return pivotTrialBalance(rawRows as ConsolTbRow[], entityCodes);
    if (tab === "is") return pivotIncomeStatement(rawRows as ConsolIsRow[], entityCodes);
    return pivotBalanceSheet(rawRows as ConsolBsRow[], entityCodes);
  }, [rawRows, entityCodes, tab]);

  // (entityCode|code) → account_id for the drill.
  const acctIdByEntityCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rawRows as Array<{ bucket: string; entity_code: string | null; code: string; account_id?: string | null }>) {
      if (r.bucket === "ENTITY" && r.account_id && r.entity_code) m.set(`${r.entity_code}|${r.code}`, r.account_id);
    }
    return m;
  }, [rawRows]);

  // Balancing proof (TB only): consolidated column must net to zero.
  const tbResidual = tab === "tb" ? pivot.totals.consolidated : 0;

  const columns: string[] = [...entityCodes, ELIM_KEY, CONSOLIDATED_KEY];
  function colLabel(col: string): string {
    if (col === ELIM_KEY) return "Eliminations";
    if (col === CONSOLIDATED_KEY) return "Consolidated";
    return col;
  }

  // Drill window for the GL detail of a given entity account.
  function glDrill(entityCode: string, code: string, name: string, accountType: string) {
    const accountId = acctIdByEntityCode.get(`${entityCode}|${code}`);
    if (!accountId) { notify("No GL detail — this entity has no activity on this account.", "info"); return; }
    const window = tab === "bs" ? { from: yearStartISO(asOf), to: asOf } : { from, to };
    setDrill({ accountId, code, name, accountType, from: window.from, to: window.to, basis });
  }

  const sagDormant = (group?.members.find((m) => m.entity_code === "SAG"))
    ? !(rawRows as Array<{ bucket: string; entity_code: string | null }>).some((r) => r.bucket === "ENTITY" && r.entity_code === "SAG")
    : false;

  // ── Export rows ─────────────────────────────────────────────────────────────
  const exportRows = useMemo(() => {
    return pivot.lines.map((l) => {
      const row: Record<string, unknown> = { code: l.code, name: l.name, account_type: l.account_type };
      for (const ec of entityCodes) row[`entity_${ec}`] = l.byEntity[ec] ?? 0;
      row.eliminations = l.elim;
      row.consolidated = l.consolidated;
      return row;
    });
  }, [pivot, entityCodes]);
  const exportColumns: ExportColumn<Record<string, unknown>>[] = useMemo(() => {
    const cols: ExportColumn<Record<string, unknown>>[] = [
      { key: "code", header: "Code" },
      { key: "name", header: "Account" },
      { key: "account_type", header: "Type" },
    ];
    for (const ec of entityCodes) cols.push({ key: `entity_${ec}`, header: ec, format: "currency_cents" });
    cols.push({ key: "eliminations", header: "Eliminations", format: "currency_cents" });
    cols.push({ key: "consolidated", header: "Consolidated", format: "currency_cents" });
    return cols;
  }, [entityCodes]);

  const tabLabel = tab === "tb" ? "Trial Balance" : tab === "is" ? "Income Statement" : "Balance Sheet";

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Consolidation</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {group ? group.name : "—"} · basis: <strong>{basis}</strong>
        </div>
      </div>

      {/* Group + tabs + config */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          Group:
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} style={selectStyle}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setTab("tb")} style={tab === "tb" ? btnSecondaryActive : btnSecondary}>Trial Balance</button>
          <button onClick={() => setTab("is")} style={tab === "is" ? btnSecondaryActive : btnSecondary}>Income Statement</button>
          <button onClick={() => setTab("bs")} style={tab === "bs" ? btnSecondaryActive : btnSecondary}>Balance Sheet</button>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setBasis("ACCRUAL")} style={basis === "ACCRUAL" ? btnSecondaryActive : btnSecondary}>Accrual</button>
          <button onClick={() => setBasis("CASH")} style={basis === "CASH" ? btnSecondaryActive : btnSecondary}>Cash</button>
        </div>
        <button onClick={() => setShowElim(true)} style={btnSecondary}>
          Eliminations{group ? ` (${group.active_rule_count})` : ""}
        </button>
        <ExportButton rows={exportRows} filename={`consolidated-${tab}-${basis}-${tab === "bs" ? asOf : `${from}_${to}`}`} sheetName={tabLabel} columns={exportColumns} />
      </div>

      {/* Date controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {tab === "bs" ? (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
            As of:
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ ...inputStyle, width: 160 }} />
          </label>
        ) : (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
              From: <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...inputStyle, width: 150 }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
              To: <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...inputStyle, width: 150 }} />
            </label>
            <DateRangePresets variant="dropdown" from={from} to={to} onChange={(f, t) => { if (f) setFrom(f); if (t) setTo(t); }} />
          </>
        )}
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
      </div>

      {sagDormant && (
        <div style={{ background: "#1e293b", border: `1px solid ${C.warn}`, color: C.textSub, padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          <strong style={{ color: C.warn }}>SAG is dormant</strong> — Syndicated Apparel Group has no posted GL activity yet, so consolidated figures equal ROF standalone. Intercompany eliminations activate automatically once SAG posts its side.
        </div>
      )}

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>
      )}

      <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginBottom: 8 }}>
        Tip: click any account row to see each entity's contribution and drill into its GL detail.
      </div>

      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead>
              <tr>
                <th style={{ ...th, minWidth: 240 }}>Account</th>
                {columns.map((col) => (
                  <th key={col} style={{ ...thNum, color: col === CONSOLIDATED_KEY ? C.text : col === ELIM_KEY ? C.warn : C.textMuted }}>
                    {colLabel(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pivot.lines.length === 0 && (
                <tr><td style={{ ...td, textAlign: "center", color: C.textMuted }} colSpan={columns.length + 1}>No data for this period.</td></tr>
              )}
              {pivot.lines.map((l) => (
                <tr
                  key={`${l.account_type}-${l.code}`}
                  onClick={() => setContribLine(l)}
                  title="View by-entity contribution and GL detail"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#162033"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                >
                  <td style={{ ...td, color: C.primary }}>
                    <span style={{ color: C.primary, marginRight: 6, fontSize: 11 }}>{l.code}</span>{l.name}
                  </td>
                  {columns.map((col) => {
                    const v = lineColumnValue(l, col);
                    const isConsol = col === CONSOLIDATED_KEY;
                    const isElim = col === ELIM_KEY;
                    return (
                      <td key={col} style={{ ...tdNum, fontWeight: isConsol ? 700 : 400, color: isElim && v !== 0 ? C.warn : isConsol ? C.text : C.textSub }}>
                        {v === 0 ? "—" : fmtCents(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: C.head }}>
                <td style={{ ...td, fontWeight: 700, color: C.textSub }}>
                  {tab === "is" ? "NET INCOME" : "TOTAL"}
                </td>
                {columns.map((col) => {
                  const v = tab === "is"
                    ? incomeStatementNetIncome(pivot, col)
                    : (col === CONSOLIDATED_KEY ? pivot.totals.consolidated : col === ELIM_KEY ? pivot.totals.elim : (pivot.totals.byEntity[col] ?? 0));
                  return (
                    <td key={col} style={{ ...tdNum, fontWeight: 700, color: col === CONSOLIDATED_KEY ? C.text : C.textSub }}>
                      {fmtCents(v)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* TB balancing proof */}
      {tab === "tb" && !loading && (
        <div style={{ marginTop: 12, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 12, color: C.textMuted }}>
            <strong style={{ color: C.textSub }}>Balancing proof</strong> — consolidated net (debits − credits) should be $0.00.
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: tbResidual === 0 ? C.success : C.danger }}>
            {fmtCents(tbResidual)}
          </div>
        </div>
      )}

      {contribLine && (
        <ContributionModal
          line={contribLine} entities={entities} tab={tab}
          onClose={() => setContribLine(null)}
          onDrill={(ec) => { glDrill(ec, contribLine.code, contribLine.name, contribLine.account_type); }}
          hasDetail={(ec) => acctIdByEntityCode.has(`${ec}|${contribLine.code}`)}
        />
      )}

      {showElim && group && (
        <EliminationsModal groupId={group.id} groupName={group.name} onClose={() => setShowElim(false)} onChanged={async () => {
          // refresh group rule counts + statement (eliminations may change figures)
          try {
            const r = await fetch("/api/internal/consolidation/groups");
            const d = await r.json();
            if (r.ok) setGroups(d.groups || []);
          } catch { /* ignore */ }
          void load();
        }} />
      )}

      {drill && <GLDetailModal target={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ── Contribution drill modal ─────────────────────────────────────────────────
function ContributionModal({ line, entities, tab, onClose, onDrill, hasDetail }: {
  line: PivotLine; entities: MemberEntity[]; tab: Tab;
  onClose: () => void; onDrill: (entityCode: string) => void; hasDetail: (entityCode: string) => boolean;
}) {
  return (
    <ModalShell title={`${line.code} · ${line.name}`} onClose={onClose} maxWidth={560}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr><th style={th}>Entity</th><th style={thNum}>Amount</th><th style={{ ...th, width: 90 }}></th></tr>
        </thead>
        <tbody>
          {entities.map((e) => {
            const v = line.byEntity[e.entity_code] ?? 0;
            const detail = hasDetail(e.entity_code);
            return (
              <tr key={e.entity_code}>
                <td style={td}>{e.entity_name} <span style={{ color: C.textMuted, fontSize: 11 }}>({e.entity_code})</span></td>
                <td style={tdNum}>{v === 0 ? "—" : fmtCents(v)}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  {detail && (
                    <span onClick={() => onDrill(e.entity_code)} style={{ color: C.primary, cursor: "pointer", fontSize: 12 }}>GL detail</span>
                  )}
                </td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ...td, color: C.warn }}>Eliminations</td>
            <td style={{ ...tdNum, color: line.elim !== 0 ? C.warn : C.textMuted }}>{line.elim === 0 ? "—" : fmtCents(line.elim)}</td>
            <td style={td}></td>
          </tr>
        </tbody>
        <tfoot>
          <tr style={{ background: C.head }}>
            <td style={{ ...td, fontWeight: 700 }}>Consolidated</td>
            <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(line.consolidated)}</td>
            <td style={td}></td>
          </tr>
        </tfoot>
      </table>
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 10 }}>
        {tab === "bs" ? "Balances as of the selected date." : "Movement over the selected period."} Consolidated = Σ entities + eliminations.
      </div>
    </ModalShell>
  );
}

// ── Eliminations config modal ────────────────────────────────────────────────
function EliminationsModal({ groupId, groupName, onClose, onChanged }: {
  groupId: string; groupName: string; onClose: () => void; onChanged: () => void;
}) {
  const [rules, setRules] = useState<ElimRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/consolidation/eliminations?group=${groupId}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRules(d.rules || []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(rule: ElimRule) {
    try {
      const r = await fetch("/api/internal/consolidation/eliminations", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, is_active: !rule.is_active }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      await load(); onChanged();
    } catch (e) { notify(e instanceof Error ? e.message : String(e), "error"); }
  }
  async function remove(rule: ElimRule) {
    const ok = await confirmDialog(
      `Delete "${rule.rule_name}" (${rule.rule_code})? This is a reporting rule only — no GL entries are affected.`,
      { title: "Delete elimination rule", confirmText: "Delete", danger: true },
    );
    if (!ok) return;
    try {
      const r = await fetch(`/api/internal/consolidation/eliminations?id=${rule.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      await load(); onChanged();
    } catch (e) { notify(e instanceof Error ? e.message : String(e), "error"); }
  }

  const leg = (entity: string | null, acct: { code: string; name: string } | null) =>
    acct ? `${entity ?? "?"} · ${acct.code} ${acct.name}` : `${entity ?? "—"} · (counterpart not booked)`;

  return (
    <ModalShell title={`Intercompany eliminations — ${groupName}`} onClose={onClose} maxWidth={860}>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
        Rules are reporting adjustments (account pairs) — never GL postings. <strong>matched_min</strong> eliminates the matched intercompany balance (LEAST of both legs), so a rule stays $0 until both entities book their side.
      </div>
      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 6, marginBottom: 10 }}>{err}</div>}
      {loading ? <div style={{ color: C.textMuted, padding: 12 }}>Loading…</div> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead>
              <tr>
                <th style={th}>Rule</th><th style={th}>Debit leg</th><th style={th}>Credit leg</th>
                <th style={th}>Method</th><th style={th}>Active</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted }} colSpan={6}>No rules yet.</td></tr>}
              {rules.map((r) => (
                <tr key={r.id}>
                  <td style={td}><div style={{ fontWeight: 600 }}>{r.rule_name}</div><div style={{ fontSize: 11, color: C.textMuted }}>{r.rule_code}</div></td>
                  <td style={{ ...td, fontSize: 12 }}>{leg(r.debit_entity, r.debit_account)}</td>
                  <td style={{ ...td, fontSize: 12 }}>{leg(r.credit_entity, r.credit_account)}</td>
                  <td style={{ ...td, fontSize: 12 }}>{r.amount_method}</td>
                  <td style={td}>
                    <span onClick={() => toggle(r)} style={{ color: r.is_active ? C.success : C.textMuted, cursor: "pointer", fontSize: 12 }}>
                      {r.is_active ? "Active" : "Off"}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <span onClick={() => remove(r)} style={{ color: C.danger, cursor: "pointer", fontSize: 12 }}>Delete</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        {adding
          ? <AddRuleForm groupId={groupId} onDone={async (created) => { setAdding(false); if (created) { await load(); onChanged(); } }} />
          : <button onClick={() => setAdding(true)} style={btnPrimary}>+ Add rule</button>}
      </div>
    </ModalShell>
  );
}

function AddRuleForm({ groupId, onDone }: { groupId: string; onDone: (created: boolean) => void }) {
  const [form, setForm] = useState({ rule_code: "", rule_name: "", reason: "", amount_method: "matched_min", fixed_amount: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    if (!form.rule_code.trim() || !form.rule_name.trim() || !form.reason.trim()) { notify("Rule code, name and reason are required.", "error"); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        group: groupId, rule_code: form.rule_code.trim(), rule_name: form.rule_name.trim(),
        reason: form.reason.trim(), amount_method: form.amount_method,
      };
      if (form.amount_method === "fixed") body.fixed_amount_cents = Math.round(Number(form.fixed_amount || 0) * 100);
      const r = await fetch("/api/internal/consolidation/eliminations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      notify("Rule added.", "success");
      onDone(true);
    } catch (e) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ background: C.inputBg, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input placeholder="Rule code (e.g. IC_LOAN_X)" value={form.rule_code} onChange={(e) => set("rule_code", e.target.value)} style={inputStyle} />
        <input placeholder="Rule name" value={form.rule_name} onChange={(e) => set("rule_name", e.target.value)} style={inputStyle} />
      </div>
      <input placeholder="Reason (why this eliminates)" value={form.reason} onChange={(e) => set("reason", e.target.value)} style={inputStyle} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 12, color: C.textSub }}>Method:
          <select value={form.amount_method} onChange={(e) => set("amount_method", e.target.value)} style={{ ...selectStyle, marginLeft: 6 }}>
            <option value="matched_min">matched_min</option>
            <option value="debit_leg">debit_leg</option>
            <option value="credit_leg">credit_leg</option>
            <option value="fixed">fixed</option>
          </select>
        </label>
        {form.amount_method === "fixed" && (
          <input placeholder="Fixed $ amount" value={form.fixed_amount} onChange={(e) => set("fixed_amount", e.target.value)} style={{ ...inputStyle, width: 140 }} />
        )}
      </div>
      <div style={{ fontSize: 11, color: C.textMuted }}>
        Point the debit/credit legs at the intercompany accounts via the API or a follow-up edit; a leg left empty is treated as $0 until the counterpart books its side.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={busy} style={btnPrimary}>{busy ? "Saving…" : "Save rule"}</button>
        <button onClick={() => onDone(false)} style={btnSecondary}>Cancel</button>
      </div>
    </div>
  );
}

// ── Reusable responsive modal shell ──────────────────────────────────────────
function ModalShell({ title, onClose, maxWidth, children }: { title: string; onClose: () => void; maxWidth: number; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, width: `min(${maxWidth}px, 95vw)`, maxHeight: "90vh", overflow: "auto", color: C.text }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${C.cardBdr}`, position: "sticky", top: 0, background: C.card, zIndex: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
          <button onClick={onClose} style={{ ...btnSecondary, padding: "4px 10px" }}>✕</button>
        </div>
        <div style={{ padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}
