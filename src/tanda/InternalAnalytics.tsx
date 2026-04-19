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
    </div>
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
