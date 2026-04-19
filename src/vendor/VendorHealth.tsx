import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";

interface HealthResponse {
  current: {
    period_start: string;
    period_end: string;
    overall: number;
    delivery: number;
    quality: number;
    compliance: number;
    financial: number;
    responsiveness: number;
    breakdown: Record<string, number | null>;
  };
  trend: { period_start: string; period_end: string; overall: number }[];
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

function scoreColor(s: number): string {
  if (s >= 80) return "#047857"; // green
  if (s >= 60) return "#C05621"; // amber
  return TH.primary;              // red
}

const TIPS: Record<string, string> = {
  delivery:       "Acknowledge POs promptly and confirm expected delivery dates. On-time delivery is 30% of your overall score.",
  quality:        "Make sure invoice line items match the PO — quantity and price. Discrepancies are the biggest driver of quality loss.",
  compliance:     "Keep required certifications uploaded and current (insurance, W-9, etc.). Documents approaching expiry reduce the score.",
  financial:      "Overdue invoices reduce your financial score. Follow up with us if an invoice is stuck and we'll help unblock.",
  responsiveness: "Acknowledge new POs within 24 hours. Faster acknowledgment = higher responsiveness score.",
};

export default function VendorHealth() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const t = await token();
        const r = await fetch("/api/vendor/analytics/health", { headers: { Authorization: `Bearer ${t}` } });
        if (!r.ok) throw new Error(await r.text());
        setData(await r.json() as HealthResponse);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading health…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!data) return null;

  const c = data.current;
  const dims: [keyof HealthResponse["current"], string][] = [
    ["delivery",       "Delivery"],
    ["quality",        "Quality"],
    ["compliance",     "Compliance"],
    ["financial",      "Financial"],
    ["responsiveness", "Responsiveness"],
  ];
  const lowest = dims.slice().sort((a, b) => (c[a[0]] as number) - (c[b[0]] as number))[0];
  const tipKey = String(lowest[0]);
  const tip = TIPS[tipKey];

  return (
    <div>
      <h2 style={{ color: "#FFFFFF", fontSize: 20, marginTop: 0, marginBottom: 16 }}>Your health score</h2>

      {/* Gauge + breakdown */}
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20, marginBottom: 20 }}>
        <Gauge score={c.overall} />
        <div>
          <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: 700, textTransform: "uppercase", marginBottom: 8, letterSpacing: 0.3 }}>
            Sub-score breakdown
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
            {dims.map(([k, label]) => {
              const v = c[k] as number;
              return (
                <div key={k} style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 12px", textAlign: "center", boxShadow: `0 1px 2px ${TH.shadow}` }}>
                  <div style={{ fontSize: 10, color: TH.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: scoreColor(v) }}>{v}</div>
                  <div style={{ fontSize: 10, color: TH.textMuted }}>/ 100</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Trend */}
      {data.trend.length > 0 && (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "18px 20px", marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: TH.text, marginBottom: 10 }}>Overall trend — last {data.trend.length} period{data.trend.length === 1 ? "" : "s"}</div>
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.trend.map((t) => ({ period: t.period_start.slice(0, 7), overall: t.overall }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="period" stroke="#718096" fontSize={11} />
                <YAxis domain={[0, 100]} stroke="#718096" fontSize={11} />
                <Tooltip />
                <Line type="monotone" dataKey="overall" stroke={TH.primary} strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Tip */}
      <div style={{ background: "#FFFAF0", border: "1px solid #FED7AA", borderRadius: 10, padding: "16px 18px" }}>
        <div style={{ color: "#C05621", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.05, marginBottom: 6 }}>
          Improvement tip — lowest dimension: {lowest[1]} ({c[lowest[0]] as number}/100)
        </div>
        <div style={{ color: "#7B341E", fontSize: 13, lineHeight: 1.5 }}>{tip}</div>
      </div>
    </div>
  );
}

function Gauge({ score }: { score: number }) {
  const color = scoreColor(score);
  const size = 220;
  const stroke = 18;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * (score / 100);
  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: 20, textAlign: "center", boxShadow: `0 1px 2px ${TH.shadow}` }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E2E8F0" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${dash} ${c}`} strokeLinecap="round" />
      </svg>
      <div style={{ marginTop: -140, fontSize: 48, fontWeight: 700, color }}>{score}</div>
      <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 80, textTransform: "uppercase", letterSpacing: 0.1, fontWeight: 700 }}>Overall health</div>
    </div>
  );
}
