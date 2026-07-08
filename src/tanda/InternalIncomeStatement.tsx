// src/tanda/InternalIncomeStatement.tsx
//
// Tangerine P5-3 / M6 — Income Statement (P&L) admin panel.
// Per docs/tangerine/P5-close-core-financials-architecture.md §5.
//
// Reads /api/internal/income-statement?basis=ACCRUAL|CASH&from=YYYY-MM-DD&to=YYYY-MM-DD.
//
// Layout:
//   1. Revenue        — account_type='revenue'                              → REVENUE
//   2. Dilution       — contra_revenue, account_subtype='dilution'          → DILUTION  (deduction)
//   3. Returns & Disc — other contra_revenue                                → (deduction)
//      → NET REVENUE = Revenue − Dilution − Returns
//   4. COGS           — account_type='expense' AND code LIKE '5%'           → COGS
//   5. Operating Exp. — account_type='expense' AND NOT code LIKE '5%'       → OPEX
//
// Subtotals:
//   Net Revenue
//   COGS
//   Gross Margin   = Net Revenue − COGS    (green if positive, red if negative)
//   OPEX
//   Operating Income = Gross Margin − OPEX
//   Net Income       = Operating Income     (until M22 adds depreciation)
//
// Sections are collapsible (default open). Currency right-aligned + tabular-nums.

import { Fragment, useEffect, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import SearchableSelect from "./components/SearchableSelect";
import GLDetailModal, { type GLDetailTarget } from "./components/GLDetailModal";

type ISRow = {
  entity_id: string;
  basis: string;
  account_type: "revenue" | "contra_revenue" | "expense" | string;
  account_id?: string | null;
  code: string;
  name: string;
  amount_cents: number | string;
  // M50 D — brand metadata (optional; present once brands are configured).
  brand_id?: string | null;
  brand_code?: string | null;
  brand_name?: string | null;
  parent_code?: string | null;
  brand_rollup?: boolean;
  is_brand_child?: boolean;
};

type Brand = { id: string; code: string; name: string; is_default?: boolean };

// A rendered line in a section: either a standalone account, or a brand-rollup
// group (parent header → indented brand-child rows → subtotal).
type DisplayItem =
  | { kind: "row"; row: ISRow }
  | { kind: "group"; parentCode: string; parentName: string; children: ISRow[]; subtotal: number };

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
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
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
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
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function fyStartISO(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

// Compute net amount sign:
//   revenue          → amount_cents (already CR-DR positive)
//   contra_revenue   → amount_cents (already DR-CR positive, REDUCES revenue)
//   expense          → amount_cents (already DR-CR positive)
//
// For NET REVENUE we sum revenue rows MINUS contra_revenue rows.
function rowAmount(r: ISRow): number {
  return Number(r.amount_cents || 0);
}

function classifyRow(r: ISRow): "revenue" | "dilution" | "contra_revenue" | "cogs" | "opex" | "other" {
  if (r.account_type === "revenue") return "revenue";
  if (r.account_type === "contra_revenue") {
    // Dilution accounts are contra_revenue tagged account_subtype='dilution';
    // they get their own P&L line between Revenue and Net Revenue. Other
    // contra_revenue (returns/discounts) stays in the contra bucket.
    return String(r.account_subtype || "").toLowerCase() === "dilution" ? "dilution" : "contra_revenue";
  }
  if (r.account_type === "expense") {
    const code = String(r.code || "");
    if (code.startsWith("5")) return "cogs";
    return "opex";
  }
  return "other";
}

// M50 D — turn a flat list of section rows into display items, grouping each
// brand-rollup parent's child accounts under a header with a subtotal. Rows are
// pre-sorted by code, so a parent (e.g. 6000) precedes its children (6000-PT,
// 6000-WS); the child branch also emits the group, so either ordering is safe.
// Rollup parents with no children render as a normal row; non-brand accounts
// render as normal rows.
function buildDisplayItems(rows: ISRow[]): DisplayItem[] {
  const childrenByParent = new Map<string, ISRow[]>();
  for (const r of rows) {
    if (r.is_brand_child && r.parent_code) {
      const arr = childrenByParent.get(r.parent_code) || [];
      arr.push(r);
      childrenByParent.set(r.parent_code, arr);
    }
  }
  const items: DisplayItem[] = [];
  const emitted = new Set<string>();
  const emitGroup = (parentCode: string, parentName: string, parentAmt: number) => {
    if (emitted.has(parentCode)) return;
    const children = childrenByParent.get(parentCode) || [];
    const subtotal = children.reduce((s, c) => s + rowAmount(c), 0) + parentAmt;
    items.push({ kind: "group", parentCode, parentName, children, subtotal });
    emitted.add(parentCode);
  };
  for (const r of rows) {
    if (r.is_brand_child && r.parent_code) {
      const parent = rows.find((x) => x.code === r.parent_code);
      emitGroup(r.parent_code, parent?.name || r.parent_code, parent ? rowAmount(parent) : 0);
      continue;
    }
    if (r.brand_rollup && childrenByParent.has(r.code)) {
      emitGroup(r.code, r.name, rowAmount(r));
      continue;
    }
    items.push({ kind: "row", row: r });
  }
  return items;
}

function countAccounts(items: DisplayItem[]): number {
  return items.reduce((n, it) => n + (it.kind === "group" ? it.children.length : 1), 0);
}

type SectionProps = {
  title: string;
  items: DisplayItem[];
  total: number;
  open: boolean;
  onToggle: () => void;
  totalLabel?: string;
  totalColor?: string;
  hideAccountNum: boolean;
  onDrill: (row: ISRow) => void;
};

function Section({ title, items, total, open, onToggle, totalLabel, totalColor, hideAccountNum, onDrill }: SectionProps) {
  const accountCount = countAccounts(items);
  const codeCell = (code: string, indent = false) =>
    hideAccountNum ? null : (
      <td style={{ ...td, color: C.textMuted, fontVariantNumeric: "tabular-nums", paddingLeft: indent ? 28 : 10 }}>{code}</td>
    );
  return (
    <div style={{ marginBottom: 16, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%", textAlign: "left", padding: "10px 14px",
          background: "#0b1220", color: C.text, border: "none", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontSize: 14, fontWeight: 600,
        }}
      >
        <span>
          <span style={{ marginRight: 8, color: C.textMuted }}>{open ? "▼" : "▶"}</span>
          {title}
          <span style={{ color: C.textMuted, marginLeft: 8, fontWeight: 400, fontSize: 12 }}>
            ({accountCount} {accountCount === 1 ? "account" : "accounts"})
          </span>
        </span>
        <span style={{ ...tdNum, padding: 0, fontWeight: 700, color: totalColor || C.text, fontSize: 14 }}>
          {totalLabel ? `${totalLabel} ` : ""}{fmtCents(total)}
        </span>
      </button>
      {open && accountCount > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {!hideAccountNum && <th style={{ ...th, width: 140 }}>Code</th>}
              <th style={th}>Account</th>
              <th style={{ ...th, textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              if (it.kind === "row") {
                const amt = rowAmount(it.row);
                const drillable = !!it.row.account_id;
                return (
                  <tr
                    key={`r-${it.row.account_type}-${it.row.code}`}
                    onClick={() => onDrill(it.row)}
                    onDoubleClick={() => onDrill(it.row)}
                    title={drillable ? "Open GL detail for this account" : undefined}
                    style={drillable ? { cursor: "pointer" } : undefined}
                    onMouseEnter={(e) => { if (drillable) e.currentTarget.style.background = "#162033"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                  >
                    {codeCell(it.row.code)}
                    <td style={td}>
                      {it.row.name}
                      {drillable && <span style={{ marginLeft: 6, color: C.primary, fontSize: 11 }}>↗</span>}
                    </td>
                    <td style={{ ...tdNum, color: amt < 0 ? C.danger : C.text }}>{fmtCents(amt)}</td>
                  </tr>
                );
              }
              // group: header → indented children → subtotal
              return (
                <Fragment key={`g-${it.parentCode}`}>
                  <tr>
                    {!hideAccountNum && (
                      <td style={{ ...td, color: C.textSub, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{it.parentCode}</td>
                    )}
                    <td style={{ ...td, fontWeight: 600 }}>{it.parentName}</td>
                    <td style={{ ...tdNum, color: C.textMuted }} />
                  </tr>
                  {it.children.map((c) => {
                    const amt = rowAmount(c);
                    const drillable = !!c.account_id;
                    return (
                      <tr
                        key={`c-${c.code}`}
                        onClick={() => onDrill(c)}
                        onDoubleClick={() => onDrill(c)}
                        title={drillable ? "Open GL detail for this account" : undefined}
                        style={drillable ? { cursor: "pointer" } : undefined}
                        onMouseEnter={(e) => { if (drillable) e.currentTarget.style.background = "#162033"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                      >
                        {codeCell(c.code, true)}
                        <td style={{ ...td, paddingLeft: hideAccountNum ? 28 : 10, color: C.textSub }}>
                          {c.brand_name || c.name}
                          {drillable && <span style={{ marginLeft: 6, color: C.primary, fontSize: 11 }}>↗</span>}
                        </td>
                        <td style={{ ...tdNum, color: amt < 0 ? C.danger : C.text }}>{fmtCents(amt)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    {!hideAccountNum && <td style={{ ...td, borderBottom: `1px solid ${C.cardBdr}` }} />}
                    <td style={{ ...td, fontStyle: "italic", color: C.textMuted, textAlign: "right" }}>
                      Subtotal — {it.parentName}
                    </td>
                    <td style={{ ...tdNum, fontWeight: 700, color: it.subtotal < 0 ? C.danger : C.text }}>
                      {fmtCents(it.subtotal)}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {open && accountCount === 0 && (
        <div style={{ padding: 14, color: C.textMuted, fontSize: 12, fontStyle: "italic" }}>
          No activity in this section for the selected range.
        </div>
      )}
    </div>
  );
}

export default function InternalIncomeStatement() {
  const [rows, setRows] = useState<ISRow[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandFilter, setBrandFilter] = useState<string>("all"); // "all" | brand id
  const [hideAccountNum, setHideAccountNum] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [basis, setBasis] = useState<"ACCRUAL" | "CASH">("ACCRUAL");
  const [from, setFrom] = useState<string>(fyStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [openRev, setOpenRev] = useState(true);
  const [openDilution, setOpenDilution] = useState(true);
  const [openReturns, setOpenReturns] = useState(true);
  const [openCogs, setOpenCogs] = useState(true);
  const [openOpex, setOpenOpex] = useState(true);
  const [drill, setDrill] = useState<GLDetailTarget | null>(null);

  // Open the GL-account drill-down scoped to the report's current from/to/basis.
  function openDrill(r: ISRow) {
    if (!r.account_id) return;
    setDrill({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      accountType: r.account_type,
      from,
      to,
      basis,
    });
  }

  // Fetch-race guard: rapid basis/date changes fire overlapping load()s; a
  // slower earlier response must never clobber the newest state.
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
      const r = await fetch(`/api/internal/income-statement?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      if (!seqGuard.isCurrent(seq)) return; // superseded by a newer load — drop stale result
      setRows((data.rows || []) as ISRow[]);
      setBrands((data.brands || []) as Brand[]);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // M50 D — per-brand filter. "all" shows every account, grouping brand children
  // under their rollup parent. A specific brand shows that brand's child accounts
  // plus shared/unallocated accounts (no brand, not a rollup parent) — a clean
  // single-brand P&L — and skips grouping (every line already belongs to one brand).
  const grouping = brandFilter === "all";
  const visibleRows = grouping
    ? rows
    : rows.filter((r) => r.brand_id === brandFilter || (!r.brand_id && !r.brand_rollup));

  // Partition rows into buckets. Dilution (contra_revenue subtype='dilution')
  // gets its own line between Revenue and Net Revenue; other contra_revenue
  // (returns/discounts) keeps its own "Returns & Discounts" section.
  const revenueRows  = visibleRows.filter((r) => classifyRow(r) === "revenue");
  const dilutionRows = visibleRows.filter((r) => classifyRow(r) === "dilution");
  const contraRows   = visibleRows.filter((r) => classifyRow(r) === "contra_revenue");
  const cogsRows     = visibleRows.filter((r) => classifyRow(r) === "cogs");
  const opexRows     = visibleRows.filter((r) => classifyRow(r) === "opex");

  const grossRevenue = revenueRows.reduce((s, r) => s + rowAmount(r), 0);
  const dilutionTotal = dilutionRows.reduce((s, r) => s + rowAmount(r), 0);
  const contraTotal  = contraRows.reduce((s, r) => s + rowAmount(r), 0);
  const netRevenue   = grossRevenue - dilutionTotal - contraTotal;
  const cogs         = cogsRows.reduce((s, r) => s + rowAmount(r), 0);
  const opex         = opexRows.reduce((s, r) => s + rowAmount(r), 0);
  const grossMargin  = netRevenue - cogs;
  const operatingIncome = grossMargin - opex;
  const netIncome    = operatingIncome; // M22 will add depreciation later

  const toItems = (rs: ISRow[]): DisplayItem[] =>
    grouping ? buildDisplayItems(rs) : rs.map((row) => ({ kind: "row", row }));
  const revenueItems  = toItems(revenueRows);
  const dilutionItems = toItems(dilutionRows);
  const returnsItems  = toItems(contraRows);
  const cogsItems     = toItems(cogsRows);
  const opexItems     = toItems(opexRows);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Income Statement</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          basis: <strong>{basis}</strong>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 0, border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
          {(["ACCRUAL", "CASH"] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBasis(b)}
              style={{
                padding: "6px 14px",
                background: basis === b ? C.primary : C.card,
                color: basis === b ? "white" : C.textSub,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {b}
            </button>
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          From:
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          To:
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
          />
        </label>
        <DateRangePresets variant="dropdown"
          from={from}
          to={to}
          onChange={(f, t) => { setFrom(f); setTo(t); }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        {brands.length > 0 && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
            Brand:
            <div style={{ width: 220 }}>
              <SearchableSelect
                value={brandFilter}
                onChange={(v) => setBrandFilter(v || "all")}
                options={[
                  { value: "all", label: "All brands (consolidated)" },
                  ...brands.map((b) => ({ value: b.id, label: `${b.name}${b.is_default ? " (default)" : ""}` })),
                ]}
                placeholder="Brand…"
              />
            </div>
          </label>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={hideAccountNum} onChange={(e) => setHideAccountNum(e.target.checked)} />
          Hide account #
        </label>
        <ExportButton
          rows={(() => {
            const out: Array<Record<string, unknown>> = [];
            const push = (section: string, kind: string, r: ISRow | null, name?: string, amt?: number) =>
              out.push({
                section, kind,
                code: r ? r.code : "",
                name: r ? r.name : (name || ""),
                brand: r?.brand_name || "",
                amount_cents: r ? rowAmount(r) : (amt ?? 0),
              });
            for (const r of revenueRows) push("Revenue", "row", r);
            push("Revenue", "subtotal", null, "REVENUE", grossRevenue);
            for (const r of dilutionRows) push("Dilution", "row", r);
            if (dilutionRows.length) push("Dilution", "subtotal", null, "DILUTION", dilutionTotal);
            for (const r of contraRows) push("Returns & Discounts", "row", r);
            if (contraRows.length) push("Returns & Discounts", "subtotal", null, "RETURNS & DISCOUNTS", contraTotal);
            push("Net Revenue", "subtotal", null, "NET REVENUE", netRevenue);
            for (const r of cogsRows) push("Cost of Goods Sold", "row", r);
            push("Cost of Goods Sold", "subtotal", null, "COGS", cogs);
            push("Gross Margin", "subtotal", null, "Gross Margin", grossMargin);
            for (const r of opexRows) push("Operating Expenses", "row", r);
            push("Operating Expenses", "subtotal", null, "OPEX", opex);
            push("Operating Income", "subtotal", null, "Operating Income", operatingIncome);
            push("Net Income", "total", null, "NET INCOME", netIncome);
            return out;
          })()}
          filename={`income-statement-${basis}-${from}-to-${to}`}
          sheetName="Income Statement"
          columns={[
            { key: "section",      header: "Section" },
            { key: "kind",         header: "Kind" },
            { key: "code",         header: "Code" },
            { key: "name",         header: "Account" },
            { key: "brand",        header: "Brand" },
            { key: "amount_cents", header: "Amount", format: "currency_cents" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginBottom: 12 }}>
        Tip: click any account row to open its GL detail (↗) for the selected range and basis.
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : (
        <>
          <Section
            title="Revenue"
            items={revenueItems}
            total={grossRevenue}
            totalLabel="REVENUE"
            open={openRev}
            onToggle={() => setOpenRev((v) => !v)}
            hideAccountNum={hideAccountNum}
            onDrill={openDrill}
          />
          {dilutionRows.length > 0 && (
            <Section
              title="Dilution"
              items={dilutionItems}
              total={dilutionTotal}
              totalLabel="DILUTION"
              totalColor={C.warn}
              open={openDilution}
              onToggle={() => setOpenDilution((v) => !v)}
              hideAccountNum={hideAccountNum}
              onDrill={openDrill}
            onDrill={openDrill}
            />
          )}
          {contraRows.length > 0 && (
            <Section
              title="Returns & Discounts"
              items={returnsItems}
              total={contraTotal}
              totalLabel="RETURNS & DISCOUNTS"
              totalColor={C.warn}
              open={openReturns}
              onToggle={() => setOpenReturns((v) => !v)}
              hideAccountNum={hideAccountNum}
              onDrill={openDrill}
            onDrill={openDrill}
            />
          )}
          {/* Net Revenue bar = Revenue − Dilution − Returns. */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "10px 16px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 700, fontSize: 14 }}>
            <span>NET REVENUE</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: netRevenue >= 0 ? C.text : C.danger }}>{fmtCents(netRevenue)}</span>
          </div>
          <Section
            title="Cost of Goods Sold"
            items={cogsItems}
            total={cogs}
            totalLabel="COGS"
            open={openCogs}
            onToggle={() => setOpenCogs((v) => !v)}
            hideAccountNum={hideAccountNum}
            onDrill={openDrill}
          />
          <Section
            title="Operating Expenses"
            items={opexItems}
            total={opex}
            totalLabel="OPEX"
            open={openOpex}
            onToggle={() => setOpenOpex((v) => !v)}
            hideAccountNum={hideAccountNum}
            onDrill={openDrill}
          />

          {/* Footer subtotals — Gross Margin, Operating Income, Net Income. */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <tr>
                  <td style={{ ...td, border: "none", color: C.textSub }}>Revenue</td>
                  <td style={{ ...tdNum, border: "none" }}>{fmtCents(grossRevenue)}</td>
                </tr>
                {dilutionTotal !== 0 && (
                  <tr>
                    <td style={{ ...td, border: "none", color: C.textSub }}>− Dilution</td>
                    <td style={{ ...tdNum, border: "none" }}>{fmtCents(dilutionTotal)}</td>
                  </tr>
                )}
                {contraTotal !== 0 && (
                  <tr>
                    <td style={{ ...td, border: "none", color: C.textSub }}>− Returns &amp; Discounts</td>
                    <td style={{ ...tdNum, border: "none" }}>{fmtCents(contraTotal)}</td>
                  </tr>
                )}
                <tr>
                  <td style={{ ...td, borderTop: `1px solid ${C.cardBdr}`, borderBottom: "none", fontWeight: 700 }}>Net Revenue</td>
                  <td style={{ ...tdNum, borderTop: `1px solid ${C.cardBdr}`, border: "none", fontWeight: 700 }}>{fmtCents(netRevenue)}</td>
                </tr>
                <tr>
                  <td style={{ ...td, border: "none", color: C.textSub }}>− Cost of Goods Sold</td>
                  <td style={{ ...tdNum, border: "none" }}>{fmtCents(cogs)}</td>
                </tr>
                <tr>
                  <td style={{ ...td, borderTop: `1px solid ${C.cardBdr}`, borderBottom: "none", fontWeight: 700 }}>
                    Gross Margin
                  </td>
                  <td style={{
                    ...tdNum,
                    borderTop: `1px solid ${C.cardBdr}`,
                    borderBottom: "none",
                    fontWeight: 700,
                    color: grossMargin >= 0 ? C.success : C.danger,
                  }}>
                    {fmtCents(grossMargin)}
                  </td>
                </tr>
                <tr>
                  <td style={{ ...td, border: "none", color: C.textSub }}>− Operating Expenses</td>
                  <td style={{ ...tdNum, border: "none" }}>{fmtCents(opex)}</td>
                </tr>
                <tr>
                  <td style={{ ...td, borderTop: `1px solid ${C.cardBdr}`, borderBottom: "none", fontWeight: 700 }}>
                    Operating Income
                  </td>
                  <td style={{
                    ...tdNum,
                    borderTop: `1px solid ${C.cardBdr}`,
                    borderBottom: "none",
                    fontWeight: 700,
                    color: operatingIncome >= 0 ? C.success : C.danger,
                  }}>
                    {fmtCents(operatingIncome)}
                  </td>
                </tr>
                <tr>
                  <td style={{ ...td, borderTop: `2px solid ${C.cardBdr}`, borderBottom: "none", fontWeight: 700, fontSize: 14 }}>
                    NET INCOME
                  </td>
                  <td style={{
                    ...tdNum,
                    borderTop: `2px solid ${C.cardBdr}`,
                    borderBottom: "none",
                    fontWeight: 700,
                    fontSize: 14,
                    color: netIncome >= 0 ? C.success : C.danger,
                  }}>
                    {fmtCents(netIncome)}
                  </td>
                </tr>
              </tbody>
            </table>
            <div style={{ marginTop: 10, color: C.textMuted, fontSize: 11, fontStyle: "italic" }}>
              Net Income = Operating Income until M22 (Fixed Assets / Depreciation) ships.
            </div>
          </div>
        </>
      )}

      {drill && <GLDetailModal target={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
