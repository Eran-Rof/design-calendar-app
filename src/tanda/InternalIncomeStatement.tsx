// src/tanda/InternalIncomeStatement.tsx
//
// Tangerine P5-3 / M6 — Income Statement (P&L) panel, best-in-class.
//
// The GL is now a 1:1 mirror of Xoro (full colon-path chart: parent groups with
// sub-accounts, contra_revenue, COGS + payroll). This panel presents that the
// way the CEO reads a P&L:
//
//   • PARENT GROUP HEADERS with indented sub-accounts + a group subtotal
//     (hierarchy = gl_accounts.parent_account_id, surfaced by the RPC as
//     parent_code / parent_name). Collapsible groups + collapsible sections.
//   • The Xoro "Income Statement By Store" BAND structure, top to bottom:
//        Revenue
//        Less: Returns, Discounts & Chargebacks
//        = NET SALES
//        Cost of Goods Sold
//        = GROSS PROFIT
//        Operating Expenses
//        = NET OPERATING INCOME
//        Other Income & Expense
//        = NET INCOME
//   • % of Net Sales column for every line + subtotal (toggle).
//   • MONTHLY COLUMNS across any date range (Jan | Feb | … | Total) — the
//     spreadsheet P&L — plus a single-period mode.
//
// Data: GET /api/internal/income-statement-monthly?basis=&from=&to= → one row
// per (account, year, month) with parent_code/parent_name/account_id + TRUE
// integer cents (mig 20260984000000). The panel pivots months into columns,
// sums them for the Total column, classifies each account into a band, and
// groups sub-accounts under their parent.
//
// Band classification (matches the CEO's Xoro export; reconciles May-2026 to the
// cent on Net Sales and within GL rounding on the cost bands):
//   Revenue      revenue accounts, code 4000–4899
//   Contra       all contra_revenue (deducted to reach Net Sales)
//   COGS         expense 5000–5999, EXCEPT non-product operating accounts
//                (Manufacturing Expense Clearing, price/label Tickets, Shipping
//                Expense — name ~ clearing|ticket|shipping), which Xoro's
//                by-store P&L treats as operating
//   Operating    expense 6000–7999 + the excluded 5xxx operating accounts
//   Other Income revenue accounts, code ≥ 4900 (FX, gains, misc income)
//   Other Exp    expense accounts, code ≥ 8000 (misc / rounding)
//
// Preserves: ACCRUAL/CASH basis toggle, date-refetch on [basis, from, to] with
// useSeqGuard, click-through to GL detail, ExportButton (xlsx). Dark theme.

import { Fragment, useEffect, useMemo, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import IncomeStatementExportButton from "./exports/IncomeStatementExportButton";
import type { StatementModel, StmtLine } from "./exports/incomeStatementExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import GLDetailModal, { type GLDetailTarget } from "./components/GLDetailModal";

// ── Raw row from the monthly RPC ─────────────────────────────────────────────
type MRow = {
  year: number;
  month: number;
  account_id: string | null;
  account_type: "revenue" | "contra_revenue" | "expense" | string;
  account_subtype: string | null;
  code: string;
  name: string;
  parent_code: string | null;
  parent_name: string | null;
  amount_cents: number | string;
};

type BandId = "revenue" | "contra" | "cogs" | "opex" | "other_inc" | "other_exp";

type Acct = {
  code: string;
  name: string;
  accountId: string | null;
  accountType: string;
  parentCode: string | null;
  parentName: string | null;
  band: BandId;
  byMonth: Record<string, number>; // monthKey → cents
  total: number;
};

type MonthCol = { y: number; m: number; key: string; label: string };
type Totalset = { byMonth: Record<string, number>; total: number };

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  band: "#0b1220",
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const thBase: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 10.5, fontWeight: 600,
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap", position: "sticky", top: 0,
};

// ── Money / percent formatting ───────────────────────────────────────────────
function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}
function fmtPct(v: number, base: number): string {
  if (!base) return "";
  return `${((v / base) * 100).toFixed(1)}%`;
}
function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function fyStartISO(): string { return `${new Date().getUTCFullYear()}-01-01`; }
// "2026-07-13" → "July 13, 2026" (TZ-safe: parse the parts, no Date drift).
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function fmtLongDate(iso: string): string {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || "";
  return `${MONTH_FULL[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// ── Band classification (see header comment) ─────────────────────────────────
const OPER_5XXX = /(clearing|ticket|shipping)/i;
export function classifyBand(accountType: string, code: string, name: string): BandId {
  if (accountType === "revenue") return code < "4900" ? "revenue" : "other_inc";
  if (accountType === "contra_revenue") return "contra";
  // expense
  if (code >= "5000" && code < "6000" && !OPER_5XXX.test(name)) return "cogs";
  if (code >= "8000") return "other_exp";
  return "opex";
}

// ── Enumerate the inclusive list of months spanning [from, to] ────────────────
export function monthsInRange(from: string, to: string): MonthCol[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  if (!fy || !fm || !ty || !tm) return [];
  const out: MonthCol[] = [];
  let y = fy, m = fm;
  while ((y < ty || (y === ty && m <= tm)) && out.length < 240) {
    out.push({ y, m, key: `${y}-${String(m).padStart(2, "0")}`, label: `${MONTH_ABBR[m - 1]} '${String(y).slice(2)}` });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ── Aggregate raw rows into per-account records keyed by code ─────────────────
function aggregate(rows: MRow[]): Acct[] {
  const map = new Map<string, Acct>();
  for (const r of rows) {
    const cents = Number(r.amount_cents || 0);
    const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
    let a = map.get(r.code);
    if (!a) {
      a = {
        code: r.code, name: r.name, accountId: r.account_id, accountType: r.account_type,
        parentCode: r.parent_code, parentName: r.parent_name,
        band: classifyBand(r.account_type, r.code, r.name),
        byMonth: {}, total: 0,
      };
      map.set(r.code, a);
    }
    a.byMonth[key] = (a.byMonth[key] || 0) + cents;
    a.total += cents;
  }
  return Array.from(map.values()).sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
}

// A rendered item inside a section: a standalone account, or a parent group with
// indented children + a subtotal.
type SectionItem =
  | { kind: "acct"; acct: Acct }
  | { kind: "group"; parentCode: string; parentName: string; children: Acct[]; byMonth: Record<string, number>; total: number };

// Turn a band's accounts into ordered items: accounts sharing a parent_code roll
// up under one group header (positioned at the first child's spot); accounts with
// no parent render standalone. Order follows account code (accts pre-sorted).
function buildItems(accts: Acct[]): SectionItem[] {
  const groups = new Map<string, { parentCode: string; parentName: string; children: Acct[]; byMonth: Record<string, number>; total: number }>();
  const order: Array<{ type: "acct"; acct: Acct } | { type: "group"; parentCode: string }> = [];
  for (const a of accts) {
    if (a.parentCode) {
      let g = groups.get(a.parentCode);
      if (!g) {
        g = { parentCode: a.parentCode, parentName: a.parentName || a.parentCode, children: [], byMonth: {}, total: 0 };
        groups.set(a.parentCode, g);
        order.push({ type: "group", parentCode: a.parentCode });
      }
      g.children.push(a);
      g.total += a.total;
      for (const [k, v] of Object.entries(a.byMonth)) g.byMonth[k] = (g.byMonth[k] || 0) + v;
    } else {
      order.push({ type: "acct", acct: a });
    }
  }
  return order.map((o) =>
    o.type === "acct"
      ? ({ kind: "acct", acct: o.acct } as SectionItem)
      : ({ kind: "group", ...groups.get(o.parentCode)! } as SectionItem),
  );
}

function sumByMonth(accts: Acct[], months: MonthCol[]): Totalset {
  const byMonth: Record<string, number> = {};
  let total = 0;
  for (const a of accts) {
    total += a.total;
    for (const mc of months) byMonth[mc.key] = (byMonth[mc.key] || 0) + (a.byMonth[mc.key] || 0);
  }
  return { byMonth, total };
}

export default function InternalIncomeStatement() {
  const [rows, setRows] = useState<MRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [basis, setBasis] = useState<"ACCRUAL" | "CASH">("ACCRUAL");
  const [from, setFrom] = useState<string>(fyStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [showMonthly, setShowMonthly] = useState(true);
  const [showPct, setShowPct] = useState(false);
  const [hideAccountNum, setHideAccountNum] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<GLDetailTarget | null>(null);

  const seqGuard = useSeqGuard();

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("basis", basis);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const r = await fetch(`/api/internal/income-statement-monthly?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      if (!seqGuard.isCurrent(seq)) return;
      setRows((data.rows || []) as MRow[]);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }

  // Refetch on basis / date-window change (seq-guard drops stale responses).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [basis, from, to]);

  const accts = useMemo(() => aggregate(rows), [rows]);
  const allMonths = useMemo(() => monthsInRange(from, to), [from, to]);
  // In single-period mode (or a one-month range) collapse to just the Total col.
  const months = showMonthly && allMonths.length > 1 ? allMonths : [];

  // Band buckets.
  const byBand = useMemo(() => {
    const b: Record<BandId, Acct[]> = { revenue: [], contra: [], cogs: [], opex: [], other_inc: [], other_exp: [] };
    for (const a of accts) b[a.band].push(a);
    return b;
  }, [accts]);

  // Section + band-subtotal totals (per month + grand total).
  const totals = useMemo(() => {
    const revenue = sumByMonth(byBand.revenue, allMonths);
    const contra = sumByMonth(byBand.contra, allMonths);
    const cogs = sumByMonth(byBand.cogs, allMonths);
    const opex = sumByMonth(byBand.opex, allMonths);
    const otherInc = sumByMonth(byBand.other_inc, allMonths);
    const otherExp = sumByMonth(byBand.other_exp, allMonths);
    const combine = (a: Record<string, number>, b: Record<string, number>, sign: number): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const mc of allMonths) out[mc.key] = (a[mc.key] || 0) + sign * (b[mc.key] || 0);
      return out;
    };
    const netSales: Totalset = { byMonth: combine(revenue.byMonth, contra.byMonth, -1), total: revenue.total - contra.total };
    const grossProfit: Totalset = { byMonth: combine(netSales.byMonth, cogs.byMonth, -1), total: netSales.total - cogs.total };
    const noi: Totalset = { byMonth: combine(grossProfit.byMonth, opex.byMonth, -1), total: grossProfit.total - opex.total };
    const otherNet: Totalset = { byMonth: combine(otherInc.byMonth, otherExp.byMonth, -1), total: otherInc.total - otherExp.total };
    const netIncome: Totalset = { byMonth: combine(noi.byMonth, otherNet.byMonth, 1), total: noi.total + otherNet.total };
    return { revenue, contra, cogs, opex, otherInc, otherExp, netSales, grossProfit, noi, otherNet, netIncome };
  }, [byBand, allMonths]);

  const nsBase = totals.netSales.total || 0;
  const leadCols = hideAccountNum ? 1 : 2; // (code?) + account

  function toggleSection(id: string) {
    setCollapsedSections((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleGroup(id: string) {
    setCollapsedGroups((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function openDrill(a: Acct) {
    if (!a.accountId) return;
    setDrill({ accountId: a.accountId, code: a.code, name: a.name, accountType: a.accountType, from, to, basis });
  }

  // ── Cell renderers ─────────────────────────────────────────────────────────
  const cellNum = (v: number, opts: { bold?: boolean; color?: string; zeroMuted?: boolean } = {}) => (
    <td style={{
      padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums",
      fontSize: 12.5, whiteSpace: "nowrap",
      color: opts.color || (v < 0 ? C.danger : C.text),
      fontWeight: opts.bold ? 700 : 400,
      borderBottom: "1px solid #1f2a3d",
    }}>
      {v === 0 && opts.zeroMuted ? <span style={{ color: C.textMuted }}>–</span> : fmtCents(v)}
    </td>
  );
  const cellPct = (v: number, opts: { bold?: boolean } = {}) => (
    showPct ? (
      <td style={{
        padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums",
        fontSize: 11.5, color: C.textMuted, whiteSpace: "nowrap", fontWeight: opts.bold ? 700 : 400,
        borderBottom: "1px solid #1f2a3d",
      }}>
        {fmtPct(v, nsBase)}
      </td>
    ) : null
  );

  // A data row's value cells: each month + Total + optional %. `sign` flips the
  // display (e.g. other-expense shown as a reduction).
  const valueCells = (byMonth: Record<string, number>, total: number, opts: { bold?: boolean; color?: string; sign?: number } = {}) => {
    const sign = opts.sign ?? 1;
    return (
      <>
        {months.map((mc) => <Fragment key={mc.key}>{cellNum(sign * (byMonth[mc.key] || 0), { bold: opts.bold, color: opts.color, zeroMuted: true })}</Fragment>)}
        {cellNum(sign * total, { bold: opts.bold, color: opts.color })}
        {cellPct(sign * total, { bold: opts.bold })}
      </>
    );
  };

  function cellCode(indent: boolean): React.CSSProperties {
    return { padding: "5px 10px", paddingLeft: indent ? 26 : 10, color: C.textMuted, fontVariantNumeric: "tabular-nums", fontSize: 12, whiteSpace: "nowrap", borderBottom: "1px solid #1f2a3d" };
  }
  function cellName(indent: boolean): React.CSSProperties {
    return { padding: "5px 10px", paddingLeft: hideAccountNum && indent ? 26 : 10, color: C.text, fontSize: 12.5, borderBottom: "1px solid #1f2a3d" };
  }

  function renderAcctRow(a: Acct, indent: boolean, sign: number) {
    const drillable = !!a.accountId;
    return (
      <tr
        key={`a-${a.band}-${a.code}`}
        onClick={() => openDrill(a)}
        title={drillable ? "Open GL detail for this account" : undefined}
        style={drillable ? { cursor: "pointer" } : undefined}
        onMouseEnter={(e) => { if (drillable) e.currentTarget.style.background = "#162033"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
      >
        {!hideAccountNum && <td style={cellCode(indent)}>{a.code}</td>}
        <td style={{ ...cellName(indent), color: C.textSub }}>
          {a.name}
          {drillable && <span style={{ marginLeft: 6, color: C.primary, fontSize: 11 }}>↗</span>}
        </td>
        {valueCells(a.byMonth, a.total, { sign })}
      </tr>
    );
  }

  // ── Section (Revenue / Deductions / COGS / OpEx / Other) ─────────────────────
  function renderSection(id: string, title: string, accounts: Acct[], sectionTotal: Totalset, sign = 1) {
    const collapsed = collapsedSections.has(id);
    const items = buildItems(accounts);
    const acctCount = accounts.length;
    return (
      <Fragment key={id}>
        <tr>
          <td colSpan={leadCols} style={{ padding: "9px 10px", background: C.band, borderTop: `1px solid ${C.cardBdr}`, cursor: "pointer", fontWeight: 600, fontSize: 13 }}
            onClick={() => toggleSection(id)}>
            <span style={{ marginRight: 8, color: C.textMuted }}>{collapsed ? "▶" : "▼"}</span>
            {title}
            <span style={{ color: C.textMuted, marginLeft: 8, fontWeight: 400, fontSize: 11 }}>
              ({acctCount} {acctCount === 1 ? "account" : "accounts"})
            </span>
          </td>
          {valueCells(sectionTotal.byMonth, sectionTotal.total, { bold: true, color: C.textSub, sign })}
        </tr>
        {!collapsed && items.map((it) => {
          if (it.kind === "acct") return renderAcctRow(it.acct, false, sign);
          const gid = `${id}:${it.parentCode}`;
          const gCollapsed = collapsedGroups.has(gid);
          return (
            <Fragment key={gid}>
              <tr onClick={() => toggleGroup(gid)} style={{ cursor: "pointer" }}>
                {!hideAccountNum && <td style={cellCode(false)}>{it.parentCode}</td>}
                <td style={{ ...cellName(false), fontWeight: 600 }}>
                  <span style={{ marginRight: 6, color: C.textMuted, fontSize: 10 }}>{gCollapsed ? "▶" : "▼"}</span>
                  {it.parentName}
                </td>
                {valueCells(it.byMonth, it.total, { color: C.textSub, sign })}
              </tr>
              {!gCollapsed && it.children.map((c) => renderAcctRow(c, true, sign))}
              {!gCollapsed && (
                <tr>
                  {!hideAccountNum && <td style={cellCode(true)} />}
                  <td style={{ ...cellName(true), fontStyle: "italic", color: C.textMuted, textAlign: "right" }}>
                    Subtotal — {it.parentName}
                  </td>
                  {valueCells(it.byMonth, it.total, { bold: true, color: C.textSub, sign })}
                </tr>
              )}
            </Fragment>
          );
        })}
      </Fragment>
    );
  }

  // ── Band subtotal row (Net Sales, Gross Profit, NOI, Net Income) ─────────────
  function bandRow(label: string, t: Totalset, opts: { strong?: boolean; positiveColor?: boolean } = {}) {
    const color = opts.positiveColor ? (t.total >= 0 ? C.success : C.danger) : C.text;
    const bg = opts.strong ? "#132132" : C.band;
    const cell: React.CSSProperties = { padding: "10px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", background: bg, borderTop: `2px solid ${C.cardBdr}`, fontWeight: 800, fontSize: 12.5, whiteSpace: "nowrap" };
    return (
      <tr>
        <td colSpan={leadCols} style={{ padding: "10px 10px", background: bg, borderTop: `2px solid ${C.cardBdr}`, fontWeight: 800, fontSize: opts.strong ? 14 : 13, letterSpacing: 0.3 }}>
          {label}
        </td>
        {months.map((mc) => (
          <td key={mc.key} style={{ ...cell, color: (t.byMonth[mc.key] || 0) < 0 ? C.danger : color }}>
            {fmtCents(t.byMonth[mc.key] || 0)}
          </td>
        ))}
        <td style={{ ...cell, fontSize: opts.strong ? 14 : 13, color }}>{fmtCents(t.total)}</td>
        {showPct && <td style={{ ...cell, fontSize: 11.5, fontWeight: 700, color: C.textMuted }}>{fmtPct(t.total, nsBase)}</td>}
      </tr>
    );
  }

  // ── Statement export model (NetSuite-style: header block + banded body) ──────
  // Built lazily on export click from the same numbers on screen. `sign` flips
  // Other-Expense so it reads as a reduction (parity with the grid).
  function buildStatementModel(): StatementModel {
    const lines: StmtLine[] = [];
    const scale = (m: Record<string, number>, sign: number): Record<string, number> => {
      if (sign === 1) return m;
      const out: Record<string, number> = {};
      for (const k of Object.keys(m)) out[k] = sign * m[k];
      return out;
    };
    const pushSection = (title: string, accounts: Acct[], sectionTotal: Totalset, sign = 1, spacerBefore = true) => {
      if (spacerBefore) lines.push({ kind: "spacer", label: "" });
      lines.push({ kind: "section", label: title, indent: 0, hasValues: false });
      for (const it of buildItems(accounts)) {
        if (it.kind === "acct") {
          lines.push({ kind: "account", code: it.acct.code, label: it.acct.name, indent: 1, byMonth: scale(it.acct.byMonth, sign), total: sign * it.acct.total });
          continue;
        }
        lines.push({ kind: "group", code: it.parentCode, label: it.parentName, indent: 1, byMonth: scale(it.byMonth, sign), total: sign * it.total });
        for (const c of it.children) lines.push({ kind: "account", code: c.code, label: c.name, indent: 2, byMonth: scale(c.byMonth, sign), total: sign * c.total });
        lines.push({ kind: "subtotal", label: `Subtotal — ${it.parentName}`, indent: 2, byMonth: scale(it.byMonth, sign), total: sign * it.total });
      }
      lines.push({ kind: "subtotal", label: `Total ${title}`, indent: 0, byMonth: scale(sectionTotal.byMonth, sign), total: sign * sectionTotal.total });
    };
    const band = (label: string, t: Totalset, strong = false) =>
      lines.push({ kind: strong ? "band_strong" : "band", label, indent: 0, byMonth: t.byMonth, total: t.total });

    pushSection("Revenue", byBand.revenue, totals.revenue, 1, false);
    if (byBand.contra.length) pushSection("Less: Returns, Discounts & Chargebacks", byBand.contra, totals.contra);
    band("NET SALES", totals.netSales, true);
    pushSection("Cost of Goods Sold", byBand.cogs, totals.cogs);
    band("GROSS PROFIT", totals.grossProfit);
    pushSection("Operating Expenses", byBand.opex, totals.opex);
    band("NET OPERATING INCOME", totals.noi);
    if (byBand.other_inc.length) pushSection("Other Income", byBand.other_inc, totals.otherInc);
    if (byBand.other_exp.length) pushSection("Other Expense", byBand.other_exp, totals.otherExp, -1);
    band("NET INCOME", totals.netIncome, true);

    return {
      company: "Ring of Fire",
      reportTitle: "Income Statement",
      periodLabel: `${fmtLongDate(from)} through ${fmtLongDate(to)}`,
      basisLabel: basis === "CASH" ? "Cash basis" : "Accrual basis",
      printedLabel: `Printed ${new Date().toLocaleString()}`,
      months: months.map((mc) => ({ key: mc.key, label: `${MONTH_ABBR[mc.m - 1]} ${mc.y}` })),
      showPct,
      hideAccountNum,
      netSalesBase: nsBase,
      lines,
    };
  }

  const rangeLabel = `${from} → ${to}`;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Income Statement</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>basis: <strong>{basis}</strong> · {rangeLabel}</div>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
          {(["ACCRUAL", "CASH"] as const).map((b) => (
            <button key={b} onClick={() => setBasis(b)} style={{ padding: "6px 14px", background: basis === b ? C.primary : C.card, color: basis === b ? "white" : C.textSub, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{b}</button>
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          From:<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          To:<input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        </label>
        <DateRangePresets variant="dropdown" from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />

        <div style={{ display: "flex", border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
          {([["monthly", "Monthly"], ["single", "Single period"]] as const).map(([v, lbl]) => {
            const active = (showMonthly ? "monthly" : "single") === v;
            return (
              <button key={v} onClick={() => setShowMonthly(v === "monthly")}
                style={{ padding: "6px 12px", background: active ? C.primary : C.card, color: active ? "white" : C.textSub, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{lbl}</button>
            );
          })}
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={showPct} onChange={(e) => setShowPct(e.target.checked)} /> % of Net Sales
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={hideAccountNum} onChange={(e) => setHideAccountNum(e.target.checked)} /> Hide account #
        </label>
        <button onClick={() => { setCollapsedSections(new Set()); setCollapsedGroups(new Set()); }} style={btnSecondary}>Expand all</button>
        <IncomeStatementExportButton
          model={buildStatementModel}
          filename={`income-statement-${basis}-${from}-to-${to}`}
          disabled={loading || accts.length === 0}
        />
      </div>

      <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginBottom: 10 }}>
        Tip: click any account row to open its GL detail (↗) for the selected range and basis. Click a section or group header to collapse it.
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : accts.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted, fontStyle: "italic" }}>No posted activity for the selected range and basis.</div>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${C.cardBdr}`, borderRadius: 10, background: C.card }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
            <thead>
              <tr>
                {!hideAccountNum && <th style={{ ...thBase, width: 90, textAlign: "left" }}>Code</th>}
                <th style={{ ...thBase, textAlign: "left", minWidth: 220 }}>Account</th>
                {months.map((mc) => <th key={mc.key} style={{ ...thBase, textAlign: "right" }}>{mc.label}</th>)}
                <th style={{ ...thBase, textAlign: "right" }}>{months.length ? "Total" : "Amount"}</th>
                {showPct && <th style={{ ...thBase, textAlign: "right" }}>% NS</th>}
              </tr>
            </thead>
            <tbody>
              {renderSection("revenue", "Revenue", byBand.revenue, totals.revenue)}
              {byBand.contra.length > 0 && renderSection("contra", "Less: Returns, Discounts & Chargebacks", byBand.contra, totals.contra)}
              {bandRow("NET SALES", totals.netSales, { strong: true })}
              {renderSection("cogs", "Cost of Goods Sold", byBand.cogs, totals.cogs)}
              {bandRow("GROSS PROFIT", totals.grossProfit, { positiveColor: true })}
              {renderSection("opex", "Operating Expenses", byBand.opex, totals.opex)}
              {bandRow("NET OPERATING INCOME", totals.noi, { positiveColor: true })}
              {byBand.other_inc.length > 0 && renderSection("other_inc", "Other Income", byBand.other_inc, totals.otherInc)}
              {byBand.other_exp.length > 0 && renderSection("other_exp", "Other Expense", byBand.other_exp, totals.otherExp, -1)}
              {bandRow("NET INCOME", totals.netIncome, { strong: true, positiveColor: true })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 10, color: C.textMuted, fontSize: 11, fontStyle: "italic" }}>
        Bands mirror Xoro's Income Statement By Store. Net Sales = Revenue − Returns/Discounts/Chargebacks; Gross Profit = Net Sales − COGS; Net Operating Income = Gross Profit − Operating Expenses; Net Income = Net Operating Income + Other Income &amp; Expense.
      </div>

      {drill && <GLDetailModal target={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
