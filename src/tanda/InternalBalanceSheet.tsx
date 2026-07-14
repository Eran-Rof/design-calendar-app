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
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import GLDetailModal, { type GLDetailTarget } from "./components/GLDetailModal";

type Basis = "ACCRUAL" | "CASH";

type BSRow = {
  entity_id: string;
  basis: string;
  account_type: "asset" | "contra_asset" | "liability" | "equity" | string;
  account_id?: string | null;
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
  position: "sticky", top: 0, zIndex: 2,
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

// Same month/day, one calendar year earlier (TZ-safe string shift). Feb-29 as-of
// dates fall back to Feb-28 of the prior year.
function priorYearISO(isoDate: string): string {
  const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoDate || "";
  const py = Number(m[1]) - 1;
  if (m[2] === "02" && m[3] === "29") return `${py}-02-28`;
  return `${py}-${m[2]}-${m[3]}`;
}

// $ change formatted with sign; "—" when there is no prior-year figure.
function pctChange(cur: number, prior: number): string {
  if (!prior) return cur ? "n/m" : "—";
  return `${(((cur - prior) / Math.abs(prior)) * 100).toFixed(1)}%`;
}

export default function InternalBalanceSheet() {
  const [rows, setRows] = useState<BSRow[]>([]);
  const [currentYearEarnings, setCurrentYearEarnings] = useState<number>(0);
  const [pyRows, setPyRows] = useState<BSRow[]>([]);
  const [pyCurrentYearEarnings, setPyCurrentYearEarnings] = useState<number>(0);
  const [comparePY, setComparePY] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [basis, setBasis] = useState<Basis>("ACCRUAL");
  const [asOf, setAsOf] = useState<string>(todayISO());
  const [drill, setDrill] = useState<GLDetailTarget | null>(null);

  // Balance Sheet is an "as of" report: drill into the account's GL detail for
  // the fiscal year-to-date window ending at the as-of date (year-start → as-of)
  // so the line activity reconciles to the balance shown.
  function openDrill(r: BSRow) {
    if (!r.account_id) return;
    setDrill({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      accountType: r.account_type,
      from: yearStartISO(asOf),
      to: asOf,
      basis,
    });
  }

  // Fetch-race guard: rapid basis/as-of changes fire overlapping load()s; a
  // slower earlier response must never clobber the newest state.
  const seqGuard = useSeqGuard();

  // Balance sheet as of a date + its year-to-date net income (Current Year
  // Earnings). Returns null on a hard failure of the BS fetch.
  async function fetchAsOf(asOfDate: string): Promise<{ rows: BSRow[]; cye: number } | null> {
    const bsParams = new URLSearchParams({ basis, as_of: asOfDate });
    const bsRes = await fetch(`/api/internal/balance-sheet?${bsParams.toString()}`);
    if (!bsRes.ok) {
      throw new Error((await bsRes.json().catch(() => ({}))).error || `HTTP ${bsRes.status}`);
    }
    const bsData = await bsRes.json();
    const bsRows = (bsData.rows || []) as BSRow[];

    // Sibling fetch: income statement YTD (year-start → as-of) for net income.
    // The IS view encodes the sign per account_type, so:
    //   net_income = Σ(revenue) − Σ(contra_revenue) − Σ(expense)
    let cye = 0;
    const isParams = new URLSearchParams({ basis, from: yearStartISO(asOfDate), to: asOfDate });
    const isRes = await fetch(`/api/internal/income-statement?${isParams.toString()}`);
    if (isRes.ok) {
      const isRows = ((await isRes.json()).rows || []) as ISRow[];
      let revenueNet = 0, contraRevenueNet = 0, expenseNet = 0;
      for (const r of isRows) {
        const amt = Number(r.amount_cents || 0);
        if (r.account_type === "revenue") revenueNet += amt;
        else if (r.account_type === "contra_revenue") contraRevenueNet += amt;
        else if (r.account_type === "expense") expenseNet += amt;
      }
      cye = revenueNet - contraRevenueNet - expenseNet;
    }
    return { rows: bsRows, cye };
  }

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      // Current + prior-year fetched together, applied together under one seq so
      // a slow comparative can never clobber a newer window (comparative fetches
      // must be guarded as a unit — see report seq-guard rule).
      const cur = await fetchAsOf(asOf);
      const py = comparePY ? await fetchAsOf(priorYearISO(asOf)) : { rows: [], cye: 0 };
      if (!seqGuard.isCurrent(seq)) return; // superseded by a newer load — drop stale result
      setRows(cur?.rows || []);
      setCurrentYearEarnings(cur?.cye || 0);
      setPyRows(py?.rows || []);
      setPyCurrentYearEarnings(py?.cye || 0);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [basis, asOf, comparePY]);

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

  // ── Prior-year comparative ──────────────────────────────────────────────
  const pyAsOf = priorYearISO(asOf);
  // code → prior-year balance_cents (display-signed: contra_asset negated).
  const pyByCode = new Map<string, number>();
  for (const r of pyRows) {
    const signed = r.account_type === "contra_asset" ? -Number(r.balance_cents || 0) : Number(r.balance_cents || 0);
    pyByCode.set(`${r.account_type}-${r.code}`, signed);
  }
  const pySum = (rs: BSRow[]) => rs.reduce((a, r) => a + Number(r.balance_cents || 0), 0);
  const pyAssetsRows = pyRows.filter((r) => r.account_type === "asset" || r.account_type === "contra_asset");
  const pyLiabRows   = pyRows.filter((r) => r.account_type === "liability");
  const pyEquityRows = pyRows.filter((r) => r.account_type === "equity");
  const pyTotalAssetsNet     = pySum(pyAssetsRows.filter((r) => r.account_type === "asset")) - pySum(pyAssetsRows.filter((r) => r.account_type === "contra_asset"));
  const pyTotalLiabilities   = pySum(pyLiabRows);
  const pyTotalEquityWithCYE = pySum(pyEquityRows) + pyCurrentYearEarnings;

  // Colspan of a section table (Account + Balance [+ PY + Change] ).
  const secCols = comparePY ? 4 : 2;

  function changeCell(cur: number, prior: number, opts: { bold?: boolean; italic?: boolean } = {}) {
    const d = cur - prior;
    return (
      <>
        <td style={{ ...tdNum, color: C.textMuted, fontWeight: opts.bold ? 700 : 400, fontStyle: opts.italic ? "italic" : undefined }}>
          {fmtCents(prior)}
        </td>
        <td style={{ ...tdNum, color: d < 0 ? C.danger : C.success, fontWeight: opts.bold ? 700 : 400, fontStyle: opts.italic ? "italic" : undefined }}>
          {fmtCents(d)}<span style={{ color: C.textMuted, fontSize: 11, marginLeft: 6 }}>{pctChange(cur, prior)}</span>
        </td>
      </>
    );
  }

  function renderSection(
    title: string,
    sectionRows: BSRow[],
    totalLabel: string,
    totalValue: number,
    pyTotalValue: number,
    options?: { extraTrailingRow?: { label: string; value: number; pyValue: number; indent?: boolean } },
  ) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ background: "#0b1220", padding: "10px 12px", fontSize: 13, fontWeight: 700, color: C.textSub, borderBottom: `1px solid ${C.cardBdr}` }}>
          {title}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: comparePY ? "40%" : "65%" }}>Account</th>
              <th style={{ ...th, textAlign: "right" }}>Balance</th>
              {comparePY && <th style={{ ...th, textAlign: "right" }}>PY {pyAsOf}</th>}
              {comparePY && <th style={{ ...th, textAlign: "right" }}>Change</th>}
            </tr>
          </thead>
          <tbody>
            {sectionRows.length === 0 && !options?.extraTrailingRow && (
              <tr>
                <td style={{ ...td, color: C.textMuted, textAlign: "center" }} colSpan={secCols}>—</td>
              </tr>
            )}
            {sectionRows.map((r) => {
              const isContra = r.account_type === "contra_asset";
              // contra_asset: render with indent + negative sign (the stored
              // balance_cents is positive — it's a credit reducing the asset).
              const displayBalance = isContra ? -Number(r.balance_cents || 0) : Number(r.balance_cents || 0);
              const pyBalance = pyByCode.get(`${r.account_type}-${r.code}`) || 0;
              const drillable = !!r.account_id;
              return (
                <tr
                  key={`${r.account_type}-${r.code}`}
                  onClick={() => openDrill(r)}
                  onDoubleClick={() => openDrill(r)}
                  title={drillable ? "Open GL detail for this account" : undefined}
                  style={drillable ? { cursor: "pointer" } : undefined}
                  onMouseEnter={(e) => { if (drillable) e.currentTarget.style.background = "#162033"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                >
                  <td style={{ ...td, paddingLeft: isContra ? 24 : 10, color: drillable ? C.primary : undefined }}>
                    <span style={{ color: drillable ? C.primary : C.textMuted, marginRight: 6, fontSize: 11 }}>{r.code}</span>
                    {r.name}
                  </td>
                  <td style={{ ...tdNum, color: isContra ? C.textMuted : C.text }}>
                    {fmtCents(displayBalance)}
                  </td>
                  {comparePY && changeCell(displayBalance, pyBalance)}
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
                {comparePY && changeCell(options.extraTrailingRow.value, options.extraTrailingRow.pyValue, { italic: true })}
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr style={{ background: "#111827" }}>
              <td style={{ ...td, fontWeight: 700, color: C.textSub }}>{totalLabel}</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totalValue)}</td>
              {comparePY && changeCell(totalValue, pyTotalValue, { bold: true })}
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
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={comparePY} onChange={(e) => setComparePY(e.target.checked)} /> Compare prior year
        </label>
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <ExportButton
          rows={(() => {
            const out: Array<Record<string, unknown>> = [];
            const mk = (section: string, kind: string, account_type: string, code: string, name: string, cur: number, py: number) =>
              (comparePY
                ? { section, kind, account_type, code, name, balance_cents: cur, py_balance_cents: py, change_cents: cur - py }
                : { section, kind, account_type, code, name, balance_cents: cur });
            for (const r of assetsRows) {
              const isContra = r.account_type === "contra_asset";
              const bal = isContra ? -Number(r.balance_cents || 0) : Number(r.balance_cents || 0);
              out.push(mk("Assets", "row", r.account_type, r.code, r.name, bal, pyByCode.get(`${r.account_type}-${r.code}`) || 0));
            }
            out.push(mk("Assets", "subtotal", "", "", "TOTAL ASSETS", totalAssetsNet, pyTotalAssetsNet));
            for (const r of liabRows) {
              out.push(mk("Liabilities", "row", r.account_type, r.code, r.name, Number(r.balance_cents || 0), pyByCode.get(`${r.account_type}-${r.code}`) || 0));
            }
            out.push(mk("Liabilities", "subtotal", "", "", "TOTAL LIABILITIES", totalLiabilities, pyTotalLiabilities));
            for (const r of equityRows) {
              out.push(mk("Equity", "row", r.account_type, r.code, r.name, Number(r.balance_cents || 0), pyByCode.get(`${r.account_type}-${r.code}`) || 0));
            }
            out.push(mk("Equity", "row", "equity", "", "Current Year Earnings", currentYearEarnings, pyCurrentYearEarnings));
            out.push(mk("Equity", "subtotal", "", "", "TOTAL EQUITY", totalEquityWithCYE, pyTotalEquityWithCYE));
            out.push(mk("Variance", "total", "", "", "Variance (Assets − Liab − Equity)", variance, pyTotalAssetsNet - pyTotalLiabilities - pyTotalEquityWithCYE));
            return out;
          })()}
          filename={`balance-sheet-${basis}-${asOf}`}
          sheetName="Balance Sheet"
          columns={[
            { key: "section",       header: "Section" },
            { key: "kind",          header: "Kind" },
            { key: "account_type",  header: "Type" },
            { key: "code",          header: "Code" },
            { key: "name",          header: "Account" },
            { key: "balance_cents", header: "Balance", format: "currency_cents" },
            ...(comparePY ? [
              { key: "py_balance_cents", header: `PY (${pyAsOf})`, format: "currency_cents" },
              { key: "change_cents",     header: "Change",         format: "currency_cents" },
            ] : []),
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginBottom: 12 }}>
        Tip: click any account (shown in blue) to open its GL detail for the year-to-date through the as-of date.
      </div>

      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: comparePY ? "1fr" : "1fr 1fr 1fr", gap: 16 }}>
            {renderSection("Assets", assetsRows, "TOTAL ASSETS", totalAssetsNet, pyTotalAssetsNet)}
            {renderSection("Liabilities", liabRows, "TOTAL LIABILITIES", totalLiabilities, pyTotalLiabilities)}
            {renderSection(
              "Equity",
              equityRows,
              "TOTAL EQUITY",
              totalEquityWithCYE,
              pyTotalEquityWithCYE,
              { extraTrailingRow: { label: "Current Year Earnings", value: currentYearEarnings, pyValue: pyCurrentYearEarnings } },
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

      {drill && <GLDetailModal target={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
