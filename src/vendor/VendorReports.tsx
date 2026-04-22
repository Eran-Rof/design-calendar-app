import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate, fmtMoney } from "./utils";

interface Summary {
  period: { from: string; to: string };
  pos_this_year: number;
  pos_by_status: { issued: number; acknowledged: number; partially_received: number; fulfilled: number; closed: number };
  invoices_this_year: number;
  invoices_by_status: { submitted: number; under_review: number; approved: number; paid: number };
  total_invoiced_ytd: number;
  total_paid_ytd: number;
  avg_payment_days: number | null;
  on_time_delivery_pct: number | null;
  invoice_accuracy_pct: number | null;
}

interface POHistoryRow {
  po_number: string;
  buyer_name: string | null;
  issued_at: string | null;
  acknowledged_at: string | null;
  fulfilled_at: string | null;
  required_by: string | null;
  total_amount: number | null;
  status: string;
  pct_received: number | null;
  on_time: boolean | null;
}

interface InvHistoryRow {
  invoice_number: string;
  po_number: string | null;
  submitted_at: string;
  approved_at: string | null;
  paid_at: string | null;
  amount: number;
  currency: string;
  status: string;
  match_status: string | null;
  days_to_payment: number | null;
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  submitted:    { bg: "#FEF3C7", fg: "#92400E" },
  under_review: { bg: "#DBEAFE", fg: "#1E40AF" },
  approved:     { bg: "#D1FAE5", fg: "#065F46" },
  paid:         { bg: "#A7F3D0", fg: "#064E3B" },
  rejected:     { bg: "#FECACA", fg: "#991B1B" },
  disputed:     { bg: "#FED7AA", fg: "#9A3412" },
  issued:             { bg: "#E5E7EB", fg: "#374151" },
  acknowledged:       { bg: "#DBEAFE", fg: "#1E40AF" },
  partially_received: { bg: "#FEF3C7", fg: "#92400E" },
  fulfilled:          { bg: "#D1FAE5", fg: "#065F46" },
  shipped_invoiced:   { bg: "#D1FAE5", fg: "#065F46" },
  closed:             { bg: "#A7F3D0", fg: "#064E3B" },
  matched:      { bg: "#D1FAE5", fg: "#065F46" },
  discrepancy:  { bg: "#FECACA", fg: "#991B1B" },
  pending:      { bg: "#E5E7EB", fg: "#374151" },
};

async function authedFetch(path: string) {
  const { data } = await supabaseVendor.auth.getSession();
  const token = data?.session?.access_token;
  return fetch(path, { headers: { Authorization: `Bearer ${token}` } });
}

// ── Date-range presets ──────────────────────────────────────────────
const PRESETS = [
  "Today", "Yesterday", "This week", "Last week",
  "Last 7 days", "Last 30 days", "Last 90 days",
  "This month", "Last month", "Month to date",
  "This quarter", "Last quarter", "Quarter to date",
  "This year", "Last year", "Year to date",
  "Last 12 months", "All time",
] as const;
type Preset = typeof PRESETS[number];

function iso(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
}

function resolvePreset(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const dow = now.getDay(); // 0 = Sunday
  const mondayOffset = (dow + 6) % 7; // days since Monday
  const quarter = Math.floor(m / 3);

  switch (preset) {
    case "Today":          return { from: iso(now), to: iso(now) };
    case "Yesterday": {
      const y1 = new Date(now); y1.setDate(y1.getDate() - 1);
      return { from: iso(y1), to: iso(y1) };
    }
    case "This week": {
      const start = new Date(now); start.setDate(now.getDate() - mondayOffset);
      return { from: iso(start), to: iso(now) };
    }
    case "Last week": {
      const end = new Date(now); end.setDate(now.getDate() - mondayOffset - 1);
      const start = new Date(end); start.setDate(end.getDate() - 6);
      return { from: iso(start), to: iso(end) };
    }
    case "Last 7 days": {
      const s = new Date(now); s.setDate(now.getDate() - 6);
      return { from: iso(s), to: iso(now) };
    }
    case "Last 30 days": {
      const s = new Date(now); s.setDate(now.getDate() - 29);
      return { from: iso(s), to: iso(now) };
    }
    case "Last 90 days": {
      const s = new Date(now); s.setDate(now.getDate() - 89);
      return { from: iso(s), to: iso(now) };
    }
    case "This month":     return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    case "Month to date":  return { from: iso(new Date(y, m, 1)), to: iso(now) };
    case "Last month":     return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "This quarter":   return { from: iso(new Date(y, quarter * 3, 1)), to: iso(new Date(y, quarter * 3 + 3, 0)) };
    case "Quarter to date": return { from: iso(new Date(y, quarter * 3, 1)), to: iso(now) };
    case "Last quarter": {
      const q = quarter === 0 ? { ys: y - 1, qm: 9 } : { ys: y, qm: (quarter - 1) * 3 };
      return { from: iso(new Date(q.ys, q.qm, 1)), to: iso(new Date(q.ys, q.qm + 3, 0)) };
    }
    case "This year":      return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) };
    case "Year to date":   return { from: iso(new Date(y, 0, 1)), to: iso(now) };
    case "Last year":      return { from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) };
    case "Last 12 months": {
      const s = new Date(y, m - 12, now.getDate());
      return { from: iso(s), to: iso(now) };
    }
    case "All time":       return { from: "2020-01-01", to: iso(now) };
  }
}

export default function VendorReports() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pos, setPOs] = useState<POHistoryRow[]>([]);
  const [invoices, setInvoices] = useState<InvHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Default to rolling last 12 months
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() - 12, d.getDate()).toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [poStatus, setPoStatus] = useState("");
  const [invStatus, setInvStatus] = useState("");
  // Lookups so we can link row-level po_number / invoice_number to
  // their detail routes without API changes.
  const [poIdByNumber, setPoIdByNumber] = useState<Record<string, string>>({});
  const [invoiceIdByNumber, setInvoiceIdByNumber] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const [{ data: poRows }, { data: invRows }] = await Promise.all([
        supabaseVendor.from("tanda_pos").select("uuid_id, po_number"),
        supabaseVendor.from("invoices").select("id, invoice_number"),
      ]);
      const pm: Record<string, string> = {};
      for (const r of (poRows ?? []) as { uuid_id: string; po_number: string }[]) pm[r.po_number] = r.uuid_id;
      setPoIdByNumber(pm);
      const im: Record<string, string> = {};
      for (const r of (invRows ?? []) as { id: string; invoice_number: string }[]) im[r.invoice_number] = r.id;
      setInvoiceIdByNumber(im);
    })();
  }, []);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const q = `?from=${fromDate}&to=${toDate}`;
      const [sRes, pRes, iRes] = await Promise.all([
        authedFetch(`/api/vendor/reports/summary${q}`),
        authedFetch(`/api/vendor/reports/pos${q}${poStatus ? `&status=${poStatus}` : ""}&limit=100`),
        authedFetch(`/api/vendor/reports/invoices${q}${invStatus ? `&status=${invStatus}` : ""}&limit=100`),
      ]);
      if (!sRes.ok) throw new Error(`summary: ${sRes.status}`);
      if (!pRes.ok) throw new Error(`pos: ${pRes.status}`);
      if (!iRes.ok) throw new Error(`invoices: ${iRes.status}`);
      setSummary(await sRes.json());
      const pJson = await pRes.json();
      setPOs(pJson.rows || []);
      const iJson = await iRes.json();
      setInvoices(iJson.rows || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch whenever any filter changes. Debounced by 200ms so rapid date
  // input typing doesn't hammer the API.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 200);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [fromDate, toDate, poStatus, invStatus]);

  const scoreColor = (pct: number | null | undefined) => {
    if (pct == null) return TH.textMuted;
    if (pct >= 95) return "#047857";
    if (pct >= 80) return "#B45309";
    return TH.primary;
  };

  if (loading && !summary) return <div style={{ color: "#FFFFFF" }}>Loading reports…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <h2 style={{ margin: "0 0 16px", color: "#FFFFFF", fontSize: 22 }}>Dashboard</h2>
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "12px 16px", marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ fontSize: 13, color: TH.textSub, fontWeight: 600 }}>Period</div>
        <select
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const r = resolvePreset(v as Preset);
            setFromDate(r.from);
            setToDate(r.to);
            e.target.value = ""; // reset so the same preset can be re-picked
          }}
          defaultValue=""
          style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13 }}
        >
          <option value="" disabled>Quick range…</option>
          <optgroup label="Short">
            <option value="Today">Today</option>
            <option value="Yesterday">Yesterday</option>
            <option value="This week">This week</option>
            <option value="Last week">Last week</option>
          </optgroup>
          <optgroup label="Rolling">
            <option value="Last 7 days">Last 7 days</option>
            <option value="Last 30 days">Last 30 days</option>
            <option value="Last 90 days">Last 90 days</option>
            <option value="Last 12 months">Last 12 months</option>
          </optgroup>
          <optgroup label="Month">
            <option value="This month">This month</option>
            <option value="Month to date">Month to date</option>
            <option value="Last month">Last month</option>
          </optgroup>
          <optgroup label="Quarter">
            <option value="This quarter">This quarter</option>
            <option value="Quarter to date">Quarter to date</option>
            <option value="Last quarter">Last quarter</option>
          </optgroup>
          <optgroup label="Year">
            <option value="This year">This year</option>
            <option value="Year to date">Year to date</option>
            <option value="Last year">Last year</option>
          </optgroup>
          <option value="All time">All time</option>
        </select>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13 }} />
        <span style={{ color: TH.textMuted }}>→</span>
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13 }} />
        <button
          onClick={() => void load()}
          disabled={loading}
          style={{
            padding: "7px 14px", borderRadius: 6, border: "none",
            background: loading ? TH.textMuted : TH.primary, color: "#FFFFFF",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {summary && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 14 }}>
            <StatCard label="POs in period" value={String(summary.pos_this_year)} to="/vendor" />
            <StatCard label="Invoices in period" value={String(summary.invoices_this_year)} to="/vendor/invoices" />
            <StatCard label="Total invoiced" value={fmtMoney(summary.total_invoiced_ytd)} to="/vendor/invoices" />
            <StatCard label="Total paid" value={fmtMoney(summary.total_paid_ytd)} tone="ok" to="/vendor/payments" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
            <KPICard label="On-time delivery" value={summary.on_time_delivery_pct != null ? `${summary.on_time_delivery_pct}%` : "—"} color={scoreColor(summary.on_time_delivery_pct)} to="/vendor/scorecard" />
            <KPICard label="Invoice accuracy" value={summary.invoice_accuracy_pct != null ? `${summary.invoice_accuracy_pct}%` : "—"} color={scoreColor(summary.invoice_accuracy_pct)} to="/vendor/scorecard" />
            <KPICard label="Avg days to payment" value={summary.avg_payment_days != null ? `${summary.avg_payment_days}d` : "—"} color={summary.avg_payment_days == null || summary.avg_payment_days > 45 ? TH.primary : "#047857"} to="/vendor/payments" />
          </div>

          <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 20px", marginBottom: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Breakdown title="POs by status" items={[
              { label: "Issued", count: summary.pos_by_status.issued },
              { label: "Acknowledged", count: summary.pos_by_status.acknowledged },
              { label: "Partially received", count: summary.pos_by_status.partially_received },
              { label: "Fulfilled", count: summary.pos_by_status.fulfilled },
              { label: "Closed", count: summary.pos_by_status.closed },
            ]} />
            <Breakdown title="Invoices by status" items={[
              { label: "Submitted", count: summary.invoices_by_status.submitted },
              { label: "Under review", count: summary.invoices_by_status.under_review },
              { label: "Approved", count: summary.invoices_by_status.approved },
              { label: "Paid", count: summary.invoices_by_status.paid },
            ]} />
          </div>
        </>
      )}

      <div style={{ color: "#FFFFFF", fontSize: 14, fontWeight: 700, margin: "8px 0 10px", letterSpacing: 0.3 }}>PO history</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <select value={poStatus} onChange={(e) => setPoStatus(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13 }}>
          <option value="">All statuses</option>
          <option value="issued">Issued</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="partially_received">Partially received</option>
          <option value="fulfilled">Fulfilled</option>
          <option value="shipped_invoiced">Shipped/Invoiced</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "140px 110px 110px 110px 110px 110px 140px 90px 80px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
          <div>PO #</div><div>Issued</div><div>Acknowledged</div><div>Fulfilled</div><div>Required by</div><div>Amount</div><div>Status</div><div>% recv</div><div style={{ textAlign: "right" }}>On-time</div>
        </div>
        {pos.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No POs in this period.</div>
        ) : pos.map((r) => {
          const c = STATUS_COLORS[r.status] ?? STATUS_COLORS.pending;
          const pct = r.pct_received;
          const pctColor = pct == null ? TH.textMuted : pct >= 100 ? "#047857" : pct >= 50 ? "#B45309" : TH.primary;
          const poUuid = poIdByNumber[r.po_number];
          const rowStyle: React.CSSProperties = {
            display: "grid",
            gridTemplateColumns: "140px 110px 110px 110px 110px 110px 140px 90px 80px",
            padding: "10px 14px",
            borderBottom: `1px solid ${TH.border}`,
            fontSize: 13,
            alignItems: "center",
            textDecoration: "none",
            color: "inherit",
          };
          const RowTag: React.ElementType = poUuid ? Link : "div";
          const rowProps: Record<string, unknown> = poUuid ? { to: `/vendor/pos/${poUuid}`, style: { ...rowStyle, cursor: "pointer" } } : { style: rowStyle };
          return (
            <RowTag key={r.po_number} {...rowProps}>
              <div style={{ fontWeight: 600, color: poUuid ? TH.primary : TH.text, fontFamily: "Menlo, monospace" }}>{r.po_number}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.issued_at)}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.acknowledged_at)}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.fulfilled_at)}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.required_by)}</div>
              <div style={{ color: TH.textSub2 }}>{fmtMoney(r.total_amount)}</div>
              <div><span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 600, textTransform: "capitalize", whiteSpace: "nowrap" }}>{r.status.replace(/_/g, " ")}</span></div>
              <div style={{ color: pctColor, fontWeight: 600 }}>{pct != null ? `${pct}%` : "—"}</div>
              <div style={{ textAlign: "right", color: r.on_time === false ? TH.primary : r.on_time === true ? "#047857" : TH.textMuted }}>
                {r.on_time == null ? "—" : r.on_time ? "Yes" : "No"}
              </div>
            </RowTag>
          );
        })}
      </div>

      <div style={{ color: "#FFFFFF", fontSize: 14, fontWeight: 700, margin: "8px 0 10px", letterSpacing: 0.3 }}>Invoice history</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <select value={invStatus} onChange={(e) => setInvStatus(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13 }}>
          <option value="">All statuses</option>
          <option value="submitted">Submitted</option>
          <option value="under_review">Under review</option>
          <option value="approved">Approved</option>
          <option value="paid">Paid</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "170px 130px 110px 110px 110px 120px 130px 100px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
          <div>Invoice #</div><div>PO #</div><div>Submitted</div><div>Approved</div><div>Paid</div><div>Amount</div><div>Status</div><div style={{ textAlign: "right" }}>Days to pay</div>
        </div>
        {invoices.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No invoices in this period.</div>
        ) : invoices.map((r) => {
          const c = STATUS_COLORS[r.status] ?? STATUS_COLORS.pending;
          const invId = invoiceIdByNumber[r.invoice_number];
          const poUuid = r.po_number ? poIdByNumber[r.po_number] : undefined;
          const rowStyle: React.CSSProperties = {
            display: "grid",
            gridTemplateColumns: "170px 130px 110px 110px 110px 120px 130px 100px",
            padding: "10px 14px",
            borderBottom: `1px solid ${TH.border}`,
            fontSize: 13,
            alignItems: "center",
            textDecoration: "none",
            color: "inherit",
          };
          const RowTag: React.ElementType = invId ? Link : "div";
          const rowProps: Record<string, unknown> = invId ? { to: `/vendor/invoices/${invId}`, style: { ...rowStyle, cursor: "pointer" } } : { style: rowStyle };
          return (
            <RowTag key={r.invoice_number} {...rowProps}>
              <div style={{ fontWeight: 600, color: invId ? TH.primary : TH.text, fontFamily: "Menlo, monospace" }}>{r.invoice_number}</div>
              <div style={{ color: TH.textSub2, fontFamily: "Menlo, monospace", fontSize: 12 }}>
                {r.po_number
                  ? (poUuid
                      // Nested Link inside a Link is illegal — render PO# as plain text
                      // here; users can get to the PO from the invoice detail page.
                      ? <span>{r.po_number}</span>
                      : r.po_number)
                  : "—"}
              </div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.submitted_at)}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.approved_at)}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.paid_at)}</div>
              <div style={{ color: TH.textSub2 }}>{fmtMoney(r.amount)}</div>
              <div><span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 600, textTransform: "capitalize" }}>{r.status.replace("_", " ")}</span></div>
              <div style={{ textAlign: "right", fontWeight: 600 }}>
                {r.days_to_payment != null ? (
                  <span style={{ color: r.days_to_payment > 45 ? TH.primary : "#047857" }}>{r.days_to_payment}d</span>
                ) : r.status === "rejected" || r.status === "disputed" ? (
                  <span style={{ color: TH.textMuted }}>—</span>
                ) : (() => {
                  // Not paid yet — show how long the invoice has been outstanding.
                  const anchor = r.approved_at || r.submitted_at;
                  if (!anchor) return <span style={{ color: TH.textMuted }}>—</span>;
                  const days = Math.floor((Date.now() - new Date(anchor).getTime()) / 86_400_000);
                  const color = days > 45 ? TH.primary : days > 30 ? "#B45309" : TH.textSub2;
                  return <span style={{ color }}>{days}d pending</span>;
                })()}
              </div>
            </RowTag>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone, to }: { label: string; value: string; tone?: "ok" | "warn" | "err"; to?: string }) {
  const color = tone === "ok" ? "#047857" : tone === "warn" ? "#B45309" : tone === "err" ? TH.primary : TH.text;
  const content = (
    <>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>
        {label}{to && <span style={{ color: TH.primary, marginLeft: 6 }}>→</span>}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </>
  );
  const baseStyle = { background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 16px", boxShadow: `0 1px 2px ${TH.shadow}`, display: "block", textDecoration: "none", color: "inherit" };
  return to ? (
    <Link to={to} style={{ ...baseStyle, cursor: "pointer" }}>{content}</Link>
  ) : (
    <div style={baseStyle}>{content}</div>
  );
}

function KPICard({ label, value, color, to }: { label: string; value: string; color: string; to?: string }) {
  const content = (
    <>
      <div style={{ fontSize: 12, color: TH.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>
        {label}{to && <span style={{ color: TH.primary, marginLeft: 6 }}>→</span>}
      </div>
      <div style={{ fontSize: 36, fontWeight: 700, color }}>{value}</div>
    </>
  );
  const baseStyle = { background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "20px 20px", boxShadow: `0 1px 2px ${TH.shadow}`, display: "block", textDecoration: "none", color: "inherit" };
  return to ? (
    <Link to={to} style={{ ...baseStyle, cursor: "pointer" }}>{content}</Link>
  ) : (
    <div style={baseStyle}>{content}</div>
  );
}

function Breakdown({ title, items }: { title: string; items: { label: string; count: number }[] }) {
  const total = items.reduce((a, i) => a + i.count, 0);
  return (
    <div>
      <div style={{ fontSize: 12, color: TH.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {items.map((i) => {
        const pct = total ? (i.count / total) * 100 : 0;
        return (
          <div key={i.label} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: TH.textSub2 }}>
              <span>{i.label}</span>
              <span style={{ fontWeight: 600, color: TH.text }}>{i.count}</span>
            </div>
            <div style={{ height: 6, background: TH.surfaceHi, borderRadius: 3, overflow: "hidden", marginTop: 4 }}>
              <div style={{ height: "100%", width: `${pct}%`, background: TH.primary }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const useMemoFormatters = useMemo; // silence unused-lint in small projects
