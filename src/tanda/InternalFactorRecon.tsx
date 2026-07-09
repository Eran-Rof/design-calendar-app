// src/tanda/InternalFactorRecon.tsx
//
// Factor Module Phase 1 — Rosenthal Capital Group.
//
// (a) Monthly statement grid: every factor_statements column (CLIENT RECAP
//     economics), imported from the monthly PDFs by scripts/import-factor-pdfs.mjs.
// (b) Drill into a month → the month-end open-AR detail (FACTORED AR DETAILED)
//     grouped by customer with computed aging buckets as of the report date.
// (c) Tie-out strip: statement ending Net OAR vs the GL 1107 (Accounts
//     Receivable - Factor) cumulative ACCRUAL balance as of month end, via the
//     existing /api/internal/trial-balance endpoint.
//
// Phase 2 (deferred): monthly factoring-cost JEs (commissions / interest /
// chargebacks) + per-invoice chargeback dispute tracking.

import React, { useEffect, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

type StatementRow = {
  id: string;
  statement_month: string; // YYYY-MM-01
  factor_name: string;
  net_sales_cents: number | string;
  cash_collections_cents: number | string;
  chargebacks_net_cents: number | string;
  commissions_cents: number | string;
  interest_cents: number | string;
  fees_other_cents: number | string;
  advances_cents: number | string;
  beginning_net_oar_cents: number | string;
  ending_net_oar_cents: number | string;
  net_due_client_beginning_cents: number | string;
  net_due_client_ending_cents: number | string;
  total_loans_cents: number | string;
  source_file: string | null;
  imported_at: string | null;
};

type OpenItemRow = {
  as_of_date: string;
  factor_customer_no: string;
  customer_name: string;
  item_num: string;
  item_type: string;
  po_num: string | null;
  item_date: string | null;
  due_date: string | null;
  terms: string | null;
  gross_amt_cents: number | string;
  item_balance_cents: number | string;
};

const C = {
  bg: "#0b1220", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  groupHeaderBg: "#162033", totalBg: "#111827",
};

const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2,
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13,
  whiteSpace: "nowrap",
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

/** "2025-07-01" → "07/2025" (statement month label). */
function fmtMonth(iso: string): string {
  const [y, m] = iso.split("-");
  return `${m}/${y}`;
}

/** ISO date → US MM/DD/YYYY. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/** Last day of a statement month ("2025-07-01" → "2025-07-31"). */
function monthEndISO(statementMonth: string): string {
  const [y, m] = statementMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/** Aging bucket vs the report as-of date (Rosenthal buckets: days past due). */
function agingBucket(dueDate: string | null, asOf: string): string {
  if (!dueDate) return "OAP";
  if (dueDate >= asOf) return "Current";
  const days = Math.round((new Date(asOf + "T00:00:00Z").getTime() - new Date(dueDate + "T00:00:00Z").getTime()) / 86400000);
  if (days <= 15) return "1–15";
  if (days <= 30) return "16–30";
  if (days <= 60) return "31–60";
  if (days <= 90) return "61–90";
  return "Over 90";
}

const STATEMENT_EXPORT_COLUMNS = [
  { key: "month_label",                     header: "Month" },
  { key: "factor_name",                     header: "Factor" },
  { key: "net_sales_cents",                 header: "Net Sales",              format: "currency_cents" },
  { key: "cash_collections_cents",          header: "Cash Collections",       format: "currency_cents" },
  { key: "chargebacks_net_cents",           header: "Chargebacks (net)",      format: "currency_cents" },
  { key: "commissions_cents",               header: "Commissions",            format: "currency_cents" },
  { key: "interest_cents",                  header: "Interest",               format: "currency_cents" },
  { key: "fees_other_cents",                header: "Fees / Other",           format: "currency_cents" },
  { key: "advances_cents",                  header: "Advances",               format: "currency_cents" },
  { key: "beginning_net_oar_cents",         header: "Beginning Net OAR",      format: "currency_cents" },
  { key: "ending_net_oar_cents",            header: "Ending Net OAR",         format: "currency_cents" },
  { key: "net_due_client_beginning_cents",  header: "Net Due Client (Beg)",   format: "currency_cents" },
  { key: "net_due_client_ending_cents",     header: "Net Due Client (End)",   format: "currency_cents" },
  { key: "total_loans_cents",               header: "Total Loans",            format: "currency_cents" },
  { key: "source_file",                     header: "Source File" },
] as ExportColumn<Record<string, unknown>>[];

const ITEM_EXPORT_COLUMNS = [
  { key: "customer_name",      header: "Customer" },
  { key: "factor_customer_no", header: "Rosenthal #" },
  { key: "item_num",           header: "Item Num" },
  { key: "item_type",          header: "Type" },
  { key: "po_num",             header: "PO Num" },
  { key: "item_date_us",       header: "Item Date" },
  { key: "due_date_us",        header: "Due Date" },
  { key: "terms",              header: "Terms" },
  { key: "aging",              header: "Aging" },
  { key: "gross_amt_cents",    header: "Gross Amt",    format: "currency_cents" },
  { key: "item_balance_cents", header: "Item Balance", format: "currency_cents" },
] as ExportColumn<Record<string, unknown>>[];

// ── Month drill modal ────────────────────────────────────────────────────────

function MonthDetailModal({ statement, onClose }: { statement: StatementRow; onClose: () => void }) {
  const [rows, setRows] = useState<OpenItemRow[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [gl1107, setGl1107] = useState<number | null>(null);
  const [glErr, setGlErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const seqGuard = useSeqGuard();

  const month = statement.statement_month.slice(0, 7); // YYYY-MM
  const monthEnd = monthEndISO(statement.statement_month);
  const endingOar = Number(statement.ending_net_oar_cents || 0);

  useEffect(() => {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    setGlErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/internal/factor/open-items?month=${month}`);
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          throw new Error(detail.error || `HTTP ${r.status}`);
        }
        const data = await r.json();
        if (!seqGuard.isCurrent(seq)) return;
        setRows(data.rows || []);
        setAsOf(data.as_of || null);
      } catch (e: unknown) {
        if (seqGuard.isCurrent(seq)) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); }
      } finally {
        if (seqGuard.isCurrent(seq)) setLoading(false);
      }
      // Tie-out: GL 1107 cumulative ACCRUAL balance as of month end.
      try {
        const r = await fetch(`/api/internal/trial-balance?basis=ACCRUAL&from=1900-01-01&to=${monthEnd}`);
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          throw new Error(detail.error || `HTTP ${r.status}`);
        }
        const data = await r.json();
        if (!seqGuard.isCurrent(seq)) return;
        const acct = (data.rows || []).find((row: { code?: string }) => String(row.code) === "1107");
        const bal = acct ? Number(acct.debit_cents || 0) - Number(acct.credit_cents || 0) : 0;
        setGl1107(bal);
      } catch (e: unknown) {
        if (seqGuard.isCurrent(seq)) setGlErr(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // Group rows by customer, preserving server order (customer_name ASC).
  const groups: Array<{ no: string; name: string; rows: OpenItemRow[] }> = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.no === r.factor_customer_no) last.rows.push(r);
    else groups.push({ no: r.factor_customer_no, name: r.customer_name, rows: [r] });
  }
  const total = rows.reduce((a, r) => a + Number(r.item_balance_cents || 0), 0);
  const diff = gl1107 === null ? null : endingOar - gl1107;

  const exportRows = rows.map((r) => ({
    ...r,
    item_date_us: fmtDate(r.item_date),
    due_date_us: fmtDate(r.due_date),
    aging: asOf ? agingBucket(r.due_date, asOf) : "",
  })) as unknown as Array<Record<string, unknown>>;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1200px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column",
          background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, color: C.text,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${C.cardBdr}` }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Open AR Detail — {fmtMonth(statement.statement_month)}</div>
            <div style={{ fontSize: 12, color: C.textMuted }}>
              {asOf ? `Report as of ${fmtDate(asOf)}` : loading ? "Loading…" : "No AR detail imported for this month"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ExportButton
              rows={exportRows}
              filename={`factor-open-ar-${asOf || month}`}
              sheetName="Open AR"
              columns={ITEM_EXPORT_COLUMNS}
            />
            <button
              onClick={onClose}
              style={{ background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer", fontSize: 13 }}
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Tie-out strip: statement ending Net OAR vs GL 1107 as of month end */}
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", padding: "10px 16px", background: C.totalBg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13 }}>
          <span>Statement ending Net OAR: <strong>{fmtCents(endingOar)}</strong></span>
          <span>
            GL 1107 (AR - Factor) as of {fmtDate(monthEnd)}:{" "}
            <strong>{glErr ? "unavailable" : gl1107 === null ? "…" : fmtCents(gl1107)}</strong>
          </span>
          <span>
            Diff:{" "}
            <strong style={{ color: diff === null ? C.textMuted : diff === 0 ? C.success : C.warn }}>
              {diff === null ? "…" : fmtCents(diff)}
            </strong>
          </span>
          {glErr && <span style={{ color: C.danger }}>Trial balance error: {glErr}</span>}
        </div>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {err && (
            <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", margin: 12, borderRadius: 6 }}>
              Error: {err}
            </div>
          )}
          {loading ? (
            <div style={{ padding: 24, textAlign: "center", color: C.textMuted }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: C.textMuted }}>
              No open-AR detail rows for {fmtMonth(statement.statement_month)}. Run scripts/import-factor-pdfs.mjs with the FACTORED AR DETAILED PDF.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Customer / Item</th>
                  <th style={th}>Type</th>
                  <th style={th}>PO Num</th>
                  <th style={th}>Item Date</th>
                  <th style={th}>Due Date</th>
                  <th style={th}>Terms</th>
                  <th style={th}>Aging</th>
                  <th style={thNum}>Gross Amt</th>
                  <th style={thNum}>Item Balance</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const sub = g.rows.reduce((a, r) => a + Number(r.item_balance_cents || 0), 0);
                  const buckets = new Map<string, number>();
                  for (const r of g.rows) {
                    const b = asOf ? agingBucket(r.due_date, asOf) : "";
                    buckets.set(b, (buckets.get(b) || 0) + Number(r.item_balance_cents || 0));
                  }
                  const isOpen = !!expanded[g.no];
                  return (
                    <React.Fragment key={g.no}>
                      <tr
                        onClick={() => setExpanded((p) => ({ ...p, [g.no]: !p[g.no] }))}
                        style={{ background: C.groupHeaderBg, cursor: "pointer" }}
                        title={isOpen ? "Collapse" : "Expand invoice rows"}
                      >
                        <td style={{ ...td, fontWeight: 700 }} colSpan={6}>
                          {isOpen ? "▾" : "▸"} {g.name} <span style={{ color: C.textMuted, fontWeight: 400 }}>(Rosenthal #{g.no} • {g.rows.length} item{g.rows.length === 1 ? "" : "s"})</span>
                        </td>
                        <td style={{ ...td, fontSize: 11, color: C.textSub }}>
                          {[...buckets.entries()].map(([b, v]) => `${b}: ${fmtCents(v)}`).join("  ")}
                        </td>
                        <td style={tdNum} />
                        <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(sub)}</td>
                      </tr>
                      {isOpen && g.rows.map((r) => (
                        <tr key={`${r.as_of_date}-${r.item_num}`}>
                          <td style={{ ...td, paddingLeft: 28, fontFamily: "monospace", color: C.textSub }}>{r.item_num}</td>
                          <td style={{ ...td, color: r.item_type === "O" ? C.warn : C.textMuted }}>{r.item_type === "O" ? "O (A/P ded.)" : "I"}</td>
                          <td style={td}>{r.po_num || "—"}</td>
                          <td style={td}>{fmtDate(r.item_date)}</td>
                          <td style={td}>{fmtDate(r.due_date)}</td>
                          <td style={td}>{r.terms || "—"}</td>
                          <td style={{ ...td, fontSize: 11, color: C.textMuted }}>{asOf ? agingBucket(r.due_date, asOf) : "—"}</td>
                          <td style={tdNum}>{fmtCents(r.gross_amt_cents)}</td>
                          <td style={{ ...tdNum, color: Number(r.item_balance_cents) < 0 ? C.warn : C.text }}>{fmtCents(r.item_balance_cents)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: C.totalBg }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={8}>TOTAL NET OAR ({rows.length} items)</td>
                  <td style={{ ...tdNum, fontWeight: 700, color: total === endingOar ? C.success : C.warn }}>{fmtCents(total)}</td>
                </tr>
                {total !== endingOar && (
                  <tr>
                    <td colSpan={9} style={{ ...td, color: C.warn, fontSize: 12 }}>
                      Σ item balances differ from the statement ending Net OAR by {fmtCents(total - endingOar)} (detail report as-of {fmtDate(asOf)} vs statement month end).
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

export default function InternalFactorRecon() {
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [drill, setDrill] = useState<StatementRow | null>(null);
  const seqGuard = useSeqGuard();

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/factor/statements");
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      if (!seqGuard.isCurrent(seq)) return;
      setRows(data.rows || []);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); }
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const exportRows = rows.map((r) => ({ ...r, month_label: fmtMonth(r.statement_month) })) as unknown as Array<Record<string, unknown>>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Factor (Rosenthal)</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => void load()}
            disabled={loading}
            style={{ background: C.primary, color: "white", border: `1px solid ${C.primary}`, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <ExportButton
            rows={exportRows}
            filename="factor-statements-rosenthal"
            sheetName="Factor Statements"
            columns={STATEMENT_EXPORT_COLUMNS}
          />
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
        Monthly CLIENT RECAP economics from Rosenthal Capital Group. Click a month to open the month-end open-AR detail and the GL 1107 tie-out.
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 220px)", overflow: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No factor statements imported yet. Run scripts/import-factor-pdfs.mjs against the Rosenthal PDFs.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Month</th>
                <th style={thNum}>Net Sales</th>
                <th style={thNum}>Collections</th>
                <th style={thNum}>Chargebacks</th>
                <th style={thNum}>Commissions</th>
                <th style={thNum}>Interest</th>
                <th style={thNum}>Fees/Other</th>
                <th style={thNum}>Advances</th>
                <th style={thNum}>Beg Net OAR</th>
                <th style={thNum}>End Net OAR</th>
                <th style={thNum}>Net Due Client</th>
                <th style={thNum}>Total Loans</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setDrill(r)}
                  title="Open month-end AR detail + GL 1107 tie-out"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = C.groupHeaderBg; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                >
                  <td style={{ ...td, fontWeight: 600 }}>
                    {fmtMonth(r.statement_month)} <span style={{ marginLeft: 4, color: C.primary, fontSize: 11 }}>↗</span>
                  </td>
                  <td style={tdNum}>{fmtCents(r.net_sales_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.cash_collections_cents)}</td>
                  <td style={{ ...tdNum, color: Number(r.chargebacks_net_cents) < 0 ? C.warn : C.text }}>{fmtCents(r.chargebacks_net_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.commissions_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.interest_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.fees_other_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.advances_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.beginning_net_oar_cents)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(r.ending_net_oar_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.net_due_client_ending_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.total_loans_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!loading && rows.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted, fontStyle: "italic" }}>
          Chargebacks shown net as printed on the statement (negative = net chargebacks). Collections and commissions shown positive.
        </div>
      )}

      {drill && <MonthDetailModal statement={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
