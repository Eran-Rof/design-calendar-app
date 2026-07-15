// src/tanda/InternalTrialBalance.tsx
//
// Tangerine P5-2 — Trial Balance admin panel.
//
// Reads /api/internal/trial-balance?basis=ACCRUAL|CASH&from=YYYY-MM-DD&to=YYYY-MM-DD.
//
// The TB is the foundation of every other financial report: it lists each
// account that has been touched by a posted JE within the date window, with
// SUM(debit), SUM(credit), and the net in both directions. The grand-total
// net SHOULD always be $0.00 — anything else means an unbalanced JE somehow
// slipped past the P1 posting guard (defense in depth). The variance row is
// rendered in red whenever non-zero.

import { useEffect, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import GLDetailModal, { type GLDetailTarget } from "./components/GLDetailModal";
import SearchableSelect from "./components/SearchableSelect";

type Row = {
  entity_id: string;
  basis: string;
  account_id: string;
  code: string | null;
  name: string | null;
  account_type: string | null;
  normal_balance: string | null;
  debit_cents: number | string;
  credit_cents: number | string;
  net_debit_cents: number | string;
  net_credit_cents: number | string;
};

type ApiResponse = {
  basis: string;
  from: string | null;
  to: string | null;
  rows: Row[];
};

type Basis = "ACCRUAL" | "CASH";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  subtotalBg: "#0d1729",
  groupHeaderBg: "#162033",
  totalBg: "#111827",
};

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: `1px solid ${C.primary}`,
  padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const selectStyle: React.CSSProperties = { ...inputStyle, width: 140 };
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
const tdNum: React.CSSProperties = {
  ...td, textAlign: "right", fontVariantNumeric: "tabular-nums",
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoMinusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Group rows by account_type and within each group sort by code ASC.
// (API already sorts by code; grouping respects that order.)
function groupByType(rows: Row[]): Array<{ type: string; rows: Row[] }> {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.account_type || "(unknown)";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  // Order: asset, contra_asset, liability, equity, revenue, contra_revenue, expense, then anything else alphabetically.
  const ORDER = ["asset", "contra_asset", "liability", "equity", "revenue", "contra_revenue", "expense"];
  const groups = Array.from(map.entries()).map(([type, rows]) => ({ type, rows }));
  groups.sort((a, b) => {
    const ia = ORDER.indexOf(a.type);
    const ib = ORDER.indexOf(b.type);
    if (ia === -1 && ib === -1) return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return groups;
}

function sumDebit(rs: Row[]): number {
  return rs.reduce((acc, r) => acc + Number(r.debit_cents || 0), 0);
}
function sumCredit(rs: Row[]): number {
  return rs.reduce((acc, r) => acc + Number(r.credit_cents || 0), 0);
}

export default function InternalTrialBalance() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [basis, setBasis] = useState<Basis>("ACCRUAL");
  const [fromDate, setFromDate] = useState<string>(isoMinusDays(90));
  const [toDate, setToDate] = useState<string>(todayISO());
  const [drill, setDrill] = useState<GLDetailTarget | null>(null);

  // Open the GL-account drill-down scoped to the report's current from/to/basis.
  function openDrill(r: Row) {
    if (!r.account_id) return;
    setDrill({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      accountType: r.account_type,
      from: fromDate,
      to: toDate,
      basis,
    });
  }

  // Fetch-race guard: rapid date-preset clicks fire overlapping load()s; a
  // slower earlier response must never clobber the newest state.
  const seqGuard = useSeqGuard();

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("basis", basis);
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      const r = await fetch(`/api/internal/trial-balance?${params.toString()}`);
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${r.status}`);
      }
      const data: ApiResponse = await r.json();
      if (!seqGuard.isCurrent(seq)) return; // superseded by a newer load — drop stale result
      setRows(data.rows || []);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) {
        setErr(e instanceof Error ? e.message : String(e));
        setRows([]);
      }
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }

  // Refetch when from/to change so that picking a <DateRangePresets> chip
  // auto-loads without a separate click on Refresh. (Basis is still on the
  // manual-Refresh path to avoid surprising mid-edit re-queries.)
  // The manual Refresh button still works — it calls load() directly.
  useEffect(() => { void load(); }, [fromDate, toDate]);

  const groups = groupByType(rows);
  const grandDebit = sumDebit(rows);
  const grandCredit = sumCredit(rows);
  const grandVariance = grandDebit - grandCredit;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Trial Balance</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {rows.length} account{rows.length === 1 ? "" : "s"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Basis
          <SearchableSelect value={basis} onChange={(v) => setBasis(v as Basis)} inputStyle={selectStyle}
            options={[
              { value: "ACCRUAL", label: "ACCRUAL" },
              { value: "CASH", label: "CASH" },
            ]}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          From
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          To
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        <DateRangePresets variant="dropdown"
          from={fromDate}
          to={toDate}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />
        <button onClick={() => void load()} style={btnPrimary} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <ExportButton
          noTotals
          // #23 Export totals — append a GRAND TOTAL row mirroring the on-screen
          // tfoot (Debits / Credits / Net) so the spreadsheet ties out.
          rows={[
            ...rows,
            {
              code: "",
              name: "GRAND TOTAL",
              account_type: "",
              normal_balance: "",
              debit_cents: grandDebit,
              credit_cents: grandCredit,
              net_debit_cents: grandVariance > 0 ? grandVariance : 0,
              net_credit_cents: grandVariance < 0 ? -grandVariance : 0,
            },
          ] as unknown as Array<Record<string, unknown>>}
          filename={`trial-balance-${basis}-${fromDate}-to-${toDate}`}
          sheetName="Trial Balance"
          columns={[
            { key: "code",            header: "Code" },
            { key: "name",            header: "Account" },
            { key: "account_type",    header: "Type" },
            { key: "normal_balance",  header: "Normal" },
            { key: "debit_cents",     header: "Debits",       format: "currency_cents" },
            { key: "credit_cents",    header: "Credits",      format: "currency_cents" },
            { key: "net_debit_cents", header: "Net Debit",    format: "currency_cents" },
            { key: "net_credit_cents",header: "Net Credit",   format: "currency_cents" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 280px)", overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No posted activity for {basis} between {fromDate} and {toDate}.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Code</th>
                <th style={th}>Name</th>
                <th style={th}>Type</th>
                <th style={th}>Normal</th>
                <th style={{ ...th, textAlign: "right" }}>Debit</th>
                <th style={{ ...th, textAlign: "right" }}>Credit</th>
                <th style={{ ...th, textAlign: "right" }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const gDebit = sumDebit(g.rows);
                const gCredit = sumCredit(g.rows);
                const gNet = gDebit - gCredit;
                return (
                  <>
                    <tr key={`hdr-${g.type}`} style={{ background: C.groupHeaderBg }}>
                      <td colSpan={7} style={{ ...td, fontWeight: 700, color: C.textSub, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11 }}>
                        {g.type.replace(/_/g, " ")}
                      </td>
                    </tr>
                    {g.rows.map((r) => {
                      const net = Number(r.debit_cents || 0) - Number(r.credit_cents || 0);
                      const drillable = !!r.account_id;
                      return (
                        <tr
                          key={r.account_id}
                          onClick={() => openDrill(r)}
                          onDoubleClick={() => openDrill(r)}
                          title={drillable ? "Open GL detail for this account" : undefined}
                          style={drillable ? { cursor: "pointer" } : undefined}
                          onMouseEnter={(e) => { if (drillable) e.currentTarget.style.background = C.groupHeaderBg; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                        >
                          <td style={{ ...td, fontFamily: "monospace", color: drillable ? C.primary : C.textSub }}>{r.code || "—"}</td>
                          <td style={{ ...td, color: drillable ? C.primary : undefined }}>
                            {r.name || "—"}
                          </td>
                          <td style={{ ...td, color: C.textMuted, fontSize: 11 }}>{r.account_type || "—"}</td>
                          <td style={{ ...td, color: C.textMuted, fontSize: 11 }}>{r.normal_balance || "—"}</td>
                          <td style={tdNum}>{fmtCents(r.debit_cents)}</td>
                          <td style={tdNum}>{fmtCents(r.credit_cents)}</td>
                          <td style={{ ...tdNum, color: net === 0 ? C.textMuted : net > 0 ? C.success : C.warn, fontWeight: 600 }}>{fmtCents(net)}</td>
                        </tr>
                      );
                    })}
                    <tr key={`sub-${g.type}`} style={{ background: C.subtotalBg }}>
                      <td style={{ ...td, fontStyle: "italic", color: C.textSub }} colSpan={4}>
                        Subtotal {g.type.replace(/_/g, " ")}
                      </td>
                      <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(gDebit)}</td>
                      <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(gCredit)}</td>
                      <td style={{ ...tdNum, fontWeight: 700, color: gNet === 0 ? C.textMuted : gNet > 0 ? C.success : C.warn }}>{fmtCents(gNet)}</td>
                    </tr>
                  </>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: C.totalBg }}>
                <td style={{ ...td, fontWeight: 700, color: C.text }} colSpan={4}>
                  GRAND TOTAL
                </td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(grandDebit)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(grandCredit)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: grandVariance === 0 ? C.success : C.danger }}>
                  {fmtCents(grandVariance)}
                </td>
              </tr>
              {grandVariance !== 0 && (
                <tr style={{ background: "#3b0a0a" }}>
                  <td colSpan={7} style={{ ...td, color: C.danger, fontWeight: 600, fontSize: 12 }}>
                    Variance is non-zero. Posted JE(s) in this range do not sum to $0.00 across DR/CR. The P1 posting guard should have prevented this — investigate the underlying journal_entry_lines.
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        )}
      </div>

      {!loading && rows.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted, fontStyle: "italic" }}>
          Tip: click an account row to open its GL detail for the selected range and basis.
        </div>
      )}

      {drill && <GLDetailModal target={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
