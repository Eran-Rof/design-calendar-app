import { useEffect, useState } from "react";
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from "recharts";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const PIE_COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#6366F1"];

interface SpendResponse {
  range: { from: string; to: string };
  totals: { spend: number; po_count: number; vendor_count: number };
  by_vendor: { vendor_id: string; name: string; spend: number }[];
  by_month: { month: string; spend: number }[];
  by_category: { category: string; spend: number }[];
  top_10_vendors: { vendor_id: string; name: string; spend: number }[];
  yoy: { current: number; prior: number; change_pct: number | null };
}

interface ForecastResponse {
  vendors: {
    vendor_id: string;
    name: string;
    forecast: { period_start: string; amount: number; confidence_pct: number }[];
    avg_monthly: number;
  }[];
}

function fmtMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default function InternalAnalytics() {
  const [spend, setSpend] = useState<SpendResponse | null>(null);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to)   params.set("to", to);
      const [s, f] = await Promise.all([
        fetch(`/api/internal/analytics/spend?${params.toString()}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText))),
        fetch("/api/internal/analytics/forecast").then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText))),
      ]);
      setSpend(s as SpendResponse);
      setForecast(f as ForecastResponse);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  if (loading) return <div style={{ color: C.textMuted }}>Loading analytics…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;
  if (!spend || !forecast) return null;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Spend & forecast</h2>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inp} />
          <span style={{ color: C.textMuted }}>→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inp} />
          <button onClick={() => void load()} style={btnPrimary}>Apply</button>
        </div>
      </div>

      {/* Totals */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <Stat label="Total spend" value={fmtMoney(spend.totals.spend)} />
        <Stat label="POs" value={String(spend.totals.po_count)} />
        <Stat label="Vendors" value={String(spend.totals.vendor_count)} />
        <Stat
          label="YoY change"
          value={spend.yoy.change_pct == null ? "—" : `${spend.yoy.change_pct > 0 ? "+" : ""}${spend.yoy.change_pct}%`}
          tone={spend.yoy.change_pct == null ? "muted" : spend.yoy.change_pct > 0 ? "success" : "danger"}
        />
      </div>

      {/* Spend over time */}
      <Panel title="Spend over time">
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <LineChart data={spend.by_month}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.cardBdr} />
              <XAxis dataKey="month" stroke={C.textMuted} fontSize={11} />
              <YAxis stroke={C.textMuted} fontSize={11} tickFormatter={(v: number) => fmtMoney(v)} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.cardBdr}` }} formatter={(v: number) => fmtMoney(v)} />
              <Line type="monotone" dataKey="spend" stroke={C.primary} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      {/* Top 10 vendors + categories side by side */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginTop: 16 }}>
        <Panel title="Top 10 vendors by spend">
          <div style={{ height: 320 }}>
            <ResponsiveContainer>
              <BarChart data={spend.top_10_vendors} layout="vertical" margin={{ left: 100 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.cardBdr} />
                <XAxis type="number" stroke={C.textMuted} fontSize={11} tickFormatter={(v: number) => fmtMoney(v)} />
                <YAxis type="category" dataKey="name" stroke={C.textMuted} fontSize={11} width={100} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.cardBdr}` }} formatter={(v: number) => fmtMoney(v)} />
                <Bar dataKey="spend" fill={C.primary} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Spend by category">
          <div style={{ height: 320 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={spend.by_category} dataKey="spend" nameKey="category" cx="50%" cy="50%" outerRadius={100} innerRadius={55} label={({ category, percent }: { category: string; percent: number }) => `${category} ${Math.round(percent * 100)}%`}>
                  {spend.by_category.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.cardBdr}` }} formatter={(v: number) => fmtMoney(v)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      {/* Forecast table */}
      <Panel title="Next 3 months forecast (per vendor)">
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", fontWeight: 700 }}>
                <th style={{ textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}` }}>Vendor</th>
                <th style={{ textAlign: "right", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}` }}>Avg / mo</th>
                {forecast.vendors[0]?.forecast.map((f, i) => (
                  <th key={i} style={{ textAlign: "right", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}` }}>{f.period_start.slice(0, 7)}</th>
                ))}
                <th style={{ textAlign: "right", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}` }}>Conf.</th>
              </tr>
            </thead>
            <tbody>
              {forecast.vendors.slice(0, 50).map((v) => (
                <tr key={v.vendor_id} style={{ borderBottom: `1px solid ${C.cardBdr}` }}>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>{v.name}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: C.textSub }}>{fmtMoney(v.avg_monthly)}</td>
                  {v.forecast.map((f, i) => (
                    <td key={i} style={{ padding: "8px 10px", textAlign: "right", color: C.textSub }}>{fmtMoney(f.amount)}</td>
                  ))}
                  <td style={{ padding: "8px 10px", textAlign: "right", color: C.textMuted }}>{v.forecast[0]?.confidence_pct ?? "—"}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Phase9Analytics />
      <FinancialAnalytics />
    </div>
  );
}

interface DiversitySpend {
  range: { from: string; to: string };
  total_spend: number;
  diversity_spend: number;
  pct: number;
  by_business_type: { type: string; spend: number; pct: number }[];
  top_vendors: { vendor_id: string; name: string; spend: number }[];
}
interface SustainTrend {
  range: { from: string; to: string };
  points: { period: string; vendor_count: number; avg_env: number | null; avg_social: number | null; avg_gov: number | null; avg_overall: number | null }[];
}
interface EsgRow {
  id: string; vendor_id: string;
  vendor?: { id: string; name: string } | null;
  environmental_score: number; social_score: number; governance_score: number; overall_score: number;
  period_start: string; period_end: string;
}

function Phase9Analytics() {
  const [esg, setEsg] = useState<EsgRow[]>([]);
  const [diversity, setDiversity] = useState<DiversitySpend | null>(null);
  const [trend, setTrend] = useState<SustainTrend | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [rEsg, rDiv, rTrend] = await Promise.all([
          fetch("/api/internal/esg-scores"),
          fetch("/api/internal/analytics/diversity-spend"),
          fetch("/api/internal/analytics/sustainability-trend"),
        ]);
        if (rEsg.ok)   setEsg(((await rEsg.json()) as { rows: EsgRow[] }).rows || []);
        if (rDiv.ok)   setDiversity(await rDiv.json() as DiversitySpend);
        if (rTrend.ok) setTrend(await rTrend.json() as SustainTrend);
      } catch { /* non-fatal */ }
    })();
  }, []);

  return (
    <>
      <Panel title="ESG leaderboard (top 10, latest period)">
        {esg.length === 0 ? <div style={{ color: C.textMuted, fontSize: 12 }}>No ESG scores yet.</div> : (
          <div style={{ display: "grid", gridTemplateColumns: "2fr 80px 80px 80px 80px", gap: 4, fontSize: 12 }}>
            <div style={{ color: C.textMuted, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>Vendor</div>
            <div style={{ color: C.textMuted, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>Env</div>
            <div style={{ color: C.textMuted, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>Social</div>
            <div style={{ color: C.textMuted, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>Gov</div>
            <div style={{ color: C.textMuted, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>Overall</div>
            {esg.slice(0, 10).map((s) => (
              <div key={s.id} style={{ display: "contents" }}>
                <div>{s.vendor?.name || s.vendor_id}</div>
                <div style={{ color: C.success }}>{Number(s.environmental_score).toFixed(0)}</div>
                <div style={{ color: C.primary }}>{Number(s.social_score).toFixed(0)}</div>
                <div style={{ color: C.warn }}>{Number(s.governance_score).toFixed(0)}</div>
                <div style={{ fontWeight: 700 }}>{Number(s.overall_score).toFixed(0)}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Diversity spend share">
        {!diversity ? <div style={{ color: C.textMuted, fontSize: 12 }}>Loading…</div> : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 12 }}>
              <Stat label="Total spend" value={fmtMoney(diversity.total_spend)} />
              <Stat label="With diversity-verified vendors" value={fmtMoney(diversity.diversity_spend)} tone="success" />
              <Stat label="Diversity share" value={`${diversity.pct.toFixed(1)}%`} tone="success" />
            </div>
            {diversity.by_business_type.length > 0 && (
              <div style={{ fontSize: 12, color: C.textSub }}>
                {diversity.by_business_type.map((b) => (
                  <div key={b.type} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: `1px dashed ${C.cardBdr}` }}>
                    <span>{b.type.replace(/_/g, " ")}</span>
                    <span>{fmtMoney(b.spend)} ({b.pct.toFixed(1)}%)</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel title="Sustainability trend (vendor-base avg ESG over time)">
        {!trend || trend.points.length === 0 ? <div style={{ color: C.textMuted, fontSize: 12 }}>No ESG history yet.</div> : (
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={trend.points}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.cardBdr} />
                <XAxis dataKey="period" stroke={C.textMuted} fontSize={11} />
                <YAxis stroke={C.textMuted} fontSize={11} domain={[0, 100]} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.cardBdr}` }} />
                <Legend />
                <Line type="monotone" dataKey="avg_overall" name="Overall" stroke={C.text} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="avg_env"     name="Env"     stroke={C.success} dot={false} />
                <Line type="monotone" dataKey="avg_social"  name="Social"  stroke={C.primary} dot={false} />
                <Line type="monotone" dataKey="avg_gov"     name="Gov"     stroke={C.warn}    dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
    </>
  );
}

interface FinancialResponse {
  ranges: { ytd: { start: string; end: string }; quarter: { start: string; end: string } };
  early_payment: {
    ytd_discount_captured: number; ytd_avg_annualized_return_pct: number;
    acceptance_rate_pct: number; cost_of_capital_pct: number;
    net_benefit_vs_capital_pct: number; offers_made: number; offers_accepted: number;
  };
  fx_exposure: {
    by_currency: { currency: string; outstanding_amount: number; intl_payments_count: number }[];
    total_outstanding_usd_est: number;
  };
  scf_utilization: {
    programs: { id: string; name: string; status: string; capacity: number; utilization: number; pct: number }[];
    by_month: { month: string; utilization: number; capacity: number }[];
    current_total_utilization: number; current_total_capacity: number; utilization_pct: number;
  };
  tax_liability: {
    quarter: { start: string; end: string };
    by_jurisdiction: { jurisdiction: string; tax_type: string; tax_owed: number }[];
    total_tax_owed: number;
  };
}

function FinancialAnalytics() {
  const [d, setD] = useState<FinancialResponse | null>(null);
  useEffect(() => { (async () => {
    try {
      const r = await fetch("/api/internal/analytics/financial");
      if (r.ok) setD(await r.json() as FinancialResponse);
    } catch { /* ignore */ }
  })(); }, []);
  if (!d) return null;
  return (
    <>
      <Panel title="Early-payment ROI (YTD)">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          <Stat label="Discount captured" value={`$${Math.round(d.early_payment.ytd_discount_captured).toLocaleString()}`} tone="success" />
          <Stat label="Annualized return" value={`${d.early_payment.ytd_avg_annualized_return_pct.toFixed(1)}%`} />
          <Stat label="Cost of capital" value={`${d.early_payment.cost_of_capital_pct.toFixed(1)}%`} tone="muted" />
          <Stat label="Net benefit" value={`${d.early_payment.net_benefit_vs_capital_pct > 0 ? "+" : ""}${d.early_payment.net_benefit_vs_capital_pct.toFixed(1)}%`} tone={d.early_payment.net_benefit_vs_capital_pct > 0 ? "success" : "danger"} />
        </div>
      </Panel>

      <Panel title="FX exposure (outstanding by currency, YTD)">
        {d.fx_exposure.by_currency.length === 0 ? <div style={{ color: C.textMuted, fontSize: 12 }}>No outstanding international payments.</div> : (
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={d.fx_exposure.by_currency}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.cardBdr} />
                <XAxis dataKey="currency" stroke={C.textMuted} fontSize={11} />
                <YAxis stroke={C.textMuted} fontSize={11} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.cardBdr}` }} />
                <Bar dataKey="outstanding_amount" fill={C.primary} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <Panel title="SCF utilization (funded by month, 12mo)">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 10 }}>
          <Stat label="Total capacity" value={`$${Math.round(d.scf_utilization.current_total_capacity).toLocaleString()}`} />
          <Stat label="Current utilization" value={`$${Math.round(d.scf_utilization.current_total_utilization).toLocaleString()}`} tone="success" />
          <Stat label="% used" value={`${d.scf_utilization.utilization_pct.toFixed(0)}%`} tone={d.scf_utilization.utilization_pct > 80 ? "danger" : "success"} />
        </div>
        {d.scf_utilization.by_month.length > 0 && (
          <div style={{ height: 180 }}>
            <ResponsiveContainer>
              <BarChart data={d.scf_utilization.by_month}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.cardBdr} />
                <XAxis dataKey="month" stroke={C.textMuted} fontSize={11} />
                <YAxis stroke={C.textMuted} fontSize={11} tickFormatter={(v: number) => fmtMoney(v)} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.cardBdr}` }} formatter={(v: number) => fmtMoney(v)} />
                <Bar dataKey="utilization" fill={C.success} />
                <Bar dataKey="capacity" fill={C.cardBdr} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <Panel title={`Tax liability by jurisdiction (Q ${d.tax_liability.quarter.start} → ${d.tax_liability.quarter.end})`}>
        {d.tax_liability.by_jurisdiction.length === 0 ? <div style={{ color: C.textMuted, fontSize: 12 }}>No tax calculations this quarter.</div> : (
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={d.tax_liability.by_jurisdiction.map((r) => ({ label: `${r.jurisdiction} · ${r.tax_type}`, tax: r.tax_owed }))}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.cardBdr} />
                <XAxis dataKey="label" stroke={C.textMuted} fontSize={11} />
                <YAxis stroke={C.textMuted} fontSize={11} tickFormatter={(v: number) => fmtMoney(v)} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.cardBdr}` }} formatter={(v: number) => fmtMoney(v)} />
                <Bar dataKey="tax" fill={C.warn} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>Total tax owed this quarter: <strong>{fmtMoney(d.tax_liability.total_tax_owed)}</strong></div>
      </Panel>
    </>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.05, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" | "muted" }) {
  const color = tone === "success" ? C.success : tone === "danger" ? C.danger : C.text;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

const inp = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "6px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
