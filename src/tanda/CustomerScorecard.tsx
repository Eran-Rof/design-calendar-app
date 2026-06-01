// src/tanda/CustomerScorecard.tsx
//
// Chunk E — Customer drill-through scorecard (operator item 1).
//
// A wide fixed-overlay modal opened from the ℹ️ button on each Customer Master
// row. Fetches /api/internal/customer-scorecard?customer_id=… and renders:
//   • header: customer + assigned sales rep(s)
//   • scorecard metric tiles (balance, avg days-to-pay, brand/gender breakdown)
//   • period block (This Year / This Month / Last Month / LY-same): units, AUR,
//     margin $/%, dilution $/%
//   • commission + net-profitability captions (formula documented in the caption)
//   • tabs: Invoices / Sales Orders / JE  (each with grand totals + ExportButton)
//   • filters: brand / gender / status (applied where sensible)
//
// HONESTY: any metric the server returns as null renders "—" with a caption
// from the server's `notes` map ("needs X"); we never fabricate a number.

import { useCallback, useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type Rep = { id: string; name: string; commission_pct: number };
type PeriodBlock = {
  from: string; to: string; units: number; aur_cents: number | null;
  revenue_cents: number; cogs_cents: number; cogs_complete: boolean;
  margin_cents: number; margin_pct: number | null;
  dilution_cents: number; dilution_pct: number | null;
};
type BrandRow = { brand_id: string | null; brand_code: string | null; brand_name: string | null; total_cents: number; order_count: number };
type GenderRow = { gender_code: string; units: number; total_cents: number };
type Invoice = {
  id: string; invoice_number: string; invoice_kind: string; gl_status: string;
  invoice_date: string; due_date: string | null;
  total_amount_cents: number; paid_amount_cents: number; source: string;
};
type SalesOrder = {
  id: string; so_number: string | null; brand_id: string | null; status: string;
  order_date: string; requested_ship_date: string | null; cancel_date: string | null;
  subtotal_cents: number; total_cents: number; currency: string;
};
type JE = {
  id: string; posting_date: string; journal_type: string; basis: string;
  source_table: string | null; source_id: string | null; description: string; status: string;
};
type Scorecard = {
  header: {
    customer_id: string; customer_name: string; customer_code: string | null; status: string | null;
    sales_rep_1: Rep | null; sales_rep_2: Rep | null;
  };
  metrics: {
    balance_cents: number; avg_days_to_pay: number | null;
    by_brand: BrandRow[]; by_brand_grand_total_cents: number;
    by_gender: GenderRow[];
    periods: { this_year: PeriodBlock; this_month: PeriodBlock; last_month: PeriodBlock; ly_same: PeriodBlock };
    commission_pct: number; commission_cents: number;
    gross_sales_cents: number; dilution_cents: number; dilution_pct: number | null;
    margin_cents: number; net_profit_cents: number; net_profit_basis: string;
  };
  invoices: Invoice[];
  sales_orders: SalesOrder[];
  journal_entries: JE[];
  notes: Record<string, string>;
};

const GENDER_LABELS: Record<string, string> = {
  M: "Men", WMS: "Women", B: "Boys", C: "Children", G: "Girls", U: "Unisex", "—": "Unspecified",
};

function fmtCents(c: number | null | undefined): string {
  if (c == null) return "—";
  return (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function fmtPct(p: number | null | undefined): string {
  if (p == null) return "—";
  return `${(p * 100).toFixed(1)}%`;
}
function fmtNum(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US");
}

const card: React.CSSProperties = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 };
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "6px 8px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 12 };
const tdR: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "SFMono-Regular, Menlo, monospace" };

function Metric({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {caption && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>{caption}</div>}
    </div>
  );
}

export default function CustomerScorecard({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const [data, setData] = useState<Scorecard | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"invoices" | "sales_orders" | "je">("invoices");

  // Filters
  const [brandId, setBrandId] = useState("");
  const [gender, setGender] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams({ customer_id: customerId });
      if (brandId) params.set("brand_id", brandId);
      if (gender) params.set("gender", gender);
      const r = await fetch(`/api/internal/customer-scorecard?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setData(await r.json() as Scorecard);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [customerId, brandId, gender]);

  useEffect(() => { void load(); }, [load]);

  const brandOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(all brands)" },
    ...((data?.metrics.by_brand || [])
      .filter((b) => b.brand_id)
      .map((b) => ({ value: b.brand_id as string, label: `${b.brand_code || ""} ${b.brand_name || ""}`.trim() || (b.brand_id as string) }))),
  ], [data]);

  const genderOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(all genders)" },
    ...Object.entries(GENDER_LABELS).filter(([k]) => k !== "—").map(([k, v]) => ({ value: k, label: v })),
  ], []);

  const filteredInvoices = useMemo(() => {
    const list = data?.invoices || [];
    return statusFilter ? list.filter((i) => i.gl_status === statusFilter) : list;
  }, [data, statusFilter]);

  const invStatuses = useMemo(
    () => Array.from(new Set((data?.invoices || []).map((i) => i.gl_status))).sort(),
    [data],
  );

  const invTotals = useMemo(() => {
    let total = 0, paid = 0;
    for (const i of filteredInvoices) { total += i.total_amount_cents || 0; paid += i.paid_amount_cents || 0; }
    return { total, paid, open: total - paid };
  }, [filteredInvoices]);

  const soTotals = useMemo(() => {
    let total = 0;
    for (const s of (data?.sales_orders || [])) total += s.total_cents || 0;
    return { total };
  }, [data]);

  const periods = data?.metrics.periods;
  const showBrandBreakdown = (data?.metrics.by_brand || []).length > 1;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1100px, 95vw)", maxHeight: "92vh", overflowY: "auto", color: C.text }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>
              {data?.header.customer_name || "Customer"} {data?.header.customer_code ? <span style={{ color: C.textMuted, fontSize: 14 }}>({data.header.customer_code})</span> : null}
            </h2>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              {[data?.header.sales_rep_1, data?.header.sales_rep_2].filter(Boolean).length > 0 ? (
                <>Sales rep: {[data?.header.sales_rep_1, data?.header.sales_rep_2].filter(Boolean).map((r) => `${r!.name} (${r!.commission_pct}%)`).join(", ")}</>
              ) : "No sales rep assigned"}
            </div>
          </div>
          <button onClick={onClose} style={{ background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Close</button>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

        {/* Filters */}
        <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ minWidth: 200 }}>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>BRAND (SO/breakdown)</div>
            <SearchableSelect value={brandId || null} onChange={setBrandId} options={brandOptions} placeholder="(all brands)" />
          </div>
          <div style={{ minWidth: 180 }}>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>GENDER</div>
            <SearchableSelect value={gender || null} onChange={setGender} options={genderOptions} placeholder="(all genders)" />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>INVOICE STATUS</div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13 }}>
              <option value="">(all)</option>
              {invStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : !data ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted }}>No data.</div>
        ) : (
          <>
            {/* Top metric tiles */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 14 }}>
              <Metric label="Customer Balance (open AR)" value={fmtCents(data.metrics.balance_cents)} caption={data.notes.balance} />
              <Metric label="Avg Days to Pay" value={data.metrics.avg_days_to_pay == null ? "—" : `${data.metrics.avg_days_to_pay} d`} caption={data.notes.avg_days_to_pay} />
              <Metric label="Commission % / $" value={`${data.metrics.commission_pct}% / ${fmtCents(data.metrics.commission_cents)}`} caption={data.notes.commission} />
              <Metric label="Net Profitability (YTD)" value={fmtCents(data.metrics.net_profit_cents)} caption={data.metrics.net_profit_basis} />
            </div>

            {/* Brand / Gender breakdown */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Purchases per Brand</div>
                <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 8 }}>{data.notes.by_brand}</div>
                {showBrandBreakdown ? (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr><th style={th}>Brand</th><th style={{ ...th, textAlign: "right" }}>Orders</th><th style={{ ...th, textAlign: "right" }}>Total</th></tr></thead>
                    <tbody>
                      {data.metrics.by_brand.map((b) => (
                        <tr key={b.brand_id || "none"}>
                          <td style={td}>{b.brand_name || b.brand_code || "(no brand)"}</td>
                          <td style={tdR}>{b.order_count}</td>
                          <td style={tdR}>{fmtCents(b.total_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ fontSize: 12, color: C.textSub }}>Single brand — see grand total.</div>
                )}
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "space-between", fontWeight: 600, fontSize: 13 }}>
                  <span>Grand total</span><span style={{ fontFamily: "monospace" }}>{fmtCents(data.metrics.by_brand_grand_total_cents)}</span>
                </div>
              </div>

              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Purchases per Gender</div>
                <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 8 }}>{data.notes.by_gender}</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Gender</th><th style={{ ...th, textAlign: "right" }}>Units</th><th style={{ ...th, textAlign: "right" }}>Revenue</th></tr></thead>
                  <tbody>
                    {data.metrics.by_gender.length === 0 ? (
                      <tr><td style={td} colSpan={3}>No line data.</td></tr>
                    ) : data.metrics.by_gender.map((g) => (
                      <tr key={g.gender_code}>
                        <td style={td}>{GENDER_LABELS[g.gender_code] || g.gender_code}</td>
                        <td style={tdR}>{fmtNum(g.units)}</td>
                        <td style={tdR}>{fmtCents(g.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Period block */}
            {periods && (
              <div style={{ ...card, marginBottom: 16, overflowX: "auto" }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Time-Period Performance</div>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
                  <thead>
                    <tr>
                      <th style={th}>Period</th>
                      <th style={{ ...th, textAlign: "right" }}>Units</th>
                      <th style={{ ...th, textAlign: "right" }}>AUR</th>
                      <th style={{ ...th, textAlign: "right" }}>Revenue</th>
                      <th style={{ ...th, textAlign: "right" }}>Margin $</th>
                      <th style={{ ...th, textAlign: "right" }}>Margin %</th>
                      <th style={{ ...th, textAlign: "right" }}>Dilution $</th>
                      <th style={{ ...th, textAlign: "right" }}>Dilution %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      ["This Year", periods.this_year],
                      ["This Month", periods.this_month],
                      ["Last Month", periods.last_month],
                      ["LY Same Period", periods.ly_same],
                    ] as const).map(([label, p]) => (
                      <tr key={label}>
                        <td style={td}>{label}</td>
                        <td style={tdR}>{fmtNum(p.units)}</td>
                        <td style={tdR}>{fmtCents(p.aur_cents)}</td>
                        <td style={tdR}>{fmtCents(p.revenue_cents)}</td>
                        <td style={tdR} title={p.cogs_complete ? undefined : "Some lines lack COGS — margin understated"}>
                          {fmtCents(p.margin_cents)}{!p.cogs_complete ? " *" : ""}
                        </td>
                        <td style={tdR}>{fmtPct(p.margin_pct)}</td>
                        <td style={tdR}>{fmtCents(p.dilution_cents)}</td>
                        <td style={tdR}>{fmtPct(p.dilution_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 6 }}>
                  Margin = revenue − COGS. AUR = revenue / units. {data.notes.dilution} "*" = some lines missing COGS (margin understated).
                </div>
              </div>
            )}

            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 12 }}>
              {([["invoices", `Invoices (${filteredInvoices.length})`], ["sales_orders", `Sales Orders (${(data.sales_orders || []).length})`], ["je", `JE (${(data.journal_entries || []).length})`]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)} style={{ background: "transparent", border: 0, borderBottom: tab === k ? `2px solid ${C.primary}` : "2px solid transparent", color: tab === k ? C.text : C.textMuted, padding: "8px 12px", fontSize: 13, fontWeight: tab === k ? 600 : 500, cursor: "pointer", marginBottom: -1 }}>{label}</button>
              ))}
            </div>

            {tab === "invoices" && (
              <div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                  <ExportButton rows={filteredInvoices as unknown as Array<Record<string, unknown>>} filename={`customer-${data.header.customer_code || data.header.customer_id}-invoices`} sheetName="Invoices" />
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Invoice #</th><th style={th}>Date</th><th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Total</th><th style={{ ...th, textAlign: "right" }}>Paid</th><th style={{ ...th, textAlign: "right" }}>Open</th></tr></thead>
                  <tbody>
                    {filteredInvoices.map((i) => (
                      <tr key={i.id}>
                        <td style={td}>{i.invoice_number}</td>
                        <td style={td}>{i.invoice_date}</td>
                        <td style={td}>{i.gl_status}</td>
                        <td style={tdR}>{fmtCents(i.total_amount_cents)}</td>
                        <td style={tdR}>{fmtCents(i.paid_amount_cents)}</td>
                        <td style={tdR}>{fmtCents((i.total_amount_cents || 0) - (i.paid_amount_cents || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td style={td} colSpan={3}>Grand total ({filteredInvoices.length})</td>
                      <td style={tdR}>{fmtCents(invTotals.total)}</td>
                      <td style={tdR}>{fmtCents(invTotals.paid)}</td>
                      <td style={tdR}>{fmtCents(invTotals.open)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {tab === "sales_orders" && (
              <div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                  <ExportButton rows={(data.sales_orders || []) as unknown as Array<Record<string, unknown>>} filename={`customer-${data.header.customer_code || data.header.customer_id}-sales-orders`} sheetName="SalesOrders" />
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>SO #</th><th style={th}>Order date</th><th style={th}>Ship date</th><th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Total</th></tr></thead>
                  <tbody>
                    {(data.sales_orders || []).map((s) => (
                      <tr key={s.id}>
                        <td style={td}>{s.so_number || "—"}</td>
                        <td style={td}>{s.order_date}</td>
                        <td style={td}>{s.requested_ship_date || "—"}</td>
                        <td style={td}>{s.status}</td>
                        <td style={tdR}>{fmtCents(s.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td style={td} colSpan={4}>Grand total ({(data.sales_orders || []).length})</td>
                      <td style={tdR}>{fmtCents(soTotals.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {tab === "je" && (
              <div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                  <ExportButton rows={(data.journal_entries || []) as unknown as Array<Record<string, unknown>>} filename={`customer-${data.header.customer_code || data.header.customer_id}-je`} sheetName="JournalEntries" />
                </div>
                <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 8 }}>Journal entries sourced from this customer's AR invoices (source_table=ar_invoices).</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Posting date</th><th style={th}>Type</th><th style={th}>Basis</th><th style={th}>Status</th><th style={th}>Description</th></tr></thead>
                  <tbody>
                    {(data.journal_entries || []).map((j) => (
                      <tr key={j.id}>
                        <td style={td}>{j.posting_date}</td>
                        <td style={td}>{j.journal_type}</td>
                        <td style={td}>{j.basis}</td>
                        <td style={td}>{j.status}</td>
                        <td style={td}>{j.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
