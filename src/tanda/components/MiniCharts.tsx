// src/tanda/components/MiniCharts.tsx
//
// Small dark-theme BI chart primitives for the Reports & Analytics hub
// (InternalReportsHub). Thin wrappers over recharts (already a repo dep) plus a
// graceful empty state so panels render cleanly before any transactions post.
//
// Palette matches the hub's `C` tokens (slate-900 surface, blue/amber/etc).

import type { ReactNode } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell, LineChart, Line,
} from "recharts";

const CH = {
  card: "#1E293B", bdr: "#334155", text: "#F1F5F9", muted: "#94A3B8",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6",
};

export const PIE_COLORS = [CH.primary, CH.warn, CH.success, CH.violet, CH.danger, "#06B6D4", "#EC4899", "#84CC16"];

function fmtMoneyShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

const tooltipStyle = {
  background: CH.card, border: `1px solid ${CH.bdr}`, borderRadius: 8,
  color: CH.text, fontSize: 12,
};

export function ChartCard({ title, subtitle, height = 220, children, empty, emptyHint }: {
  title: string; subtitle?: string; height?: number;
  children: ReactNode; empty?: boolean; emptyHint?: string;
}) {
  return (
    <div style={{ background: CH.card, border: `1px solid ${CH.bdr}`, borderRadius: 10, padding: 14 }}>
      <div style={{ color: CH.text, fontSize: 14, fontWeight: 600 }}>{title}</div>
      {subtitle && <div style={{ color: CH.muted, fontSize: 11, marginTop: 2 }}>{subtitle}</div>}
      <div style={{ height, marginTop: 10 }}>
        {empty
          ? <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: CH.muted, fontSize: 12, textAlign: "center", padding: 12 }}>
              {emptyHint || "No data yet — reads $0 until transactions post."}
            </div>
          : children}
      </div>
    </div>
  );
}

// Horizontal bar chart, e.g. spend by vendor. data: [{ label, value }]
export function HBarChart({ data, color = CH.primary, money = true }: {
  data: { label: string; value: number }[]; color?: string; money?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <XAxis type="number" tick={{ fill: CH.muted, fontSize: 10 }} tickFormatter={money ? fmtMoneyShort : undefined} />
        <YAxis type="category" dataKey="label" width={110} tick={{ fill: CH.muted, fontSize: 10 }} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(255,255,255,0.05)" }}
          formatter={(v: number) => (money ? fmtMoneyShort(v) : v)} />
        <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// Donut chart, e.g. AR vs AP composition. data: [{ label, value }]
export function DonutChart({ data, money = true }: {
  data: { label: string; value: number }[]; money?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="label" innerRadius="55%" outerRadius="80%" paddingAngle={2} stroke="none">
          {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n) => [money ? fmtMoneyShort(v) : v, n]} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// Monthly line/trend chart. data: [{ label, value }]
export function TrendChart({ data, color = CH.success, money = true }: {
  data: { label: string; value: number }[]; color?: string; money?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ left: 0, right: 12, top: 6, bottom: 4 }}>
        <XAxis dataKey="label" tick={{ fill: CH.muted, fontSize: 10 }} />
        <YAxis tick={{ fill: CH.muted, fontSize: 10 }} tickFormatter={money ? fmtMoneyShort : undefined} width={48} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => (money ? fmtMoneyShort(v) : v)} />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// Inline SVG sparkline for KPI tiles (tiny, no axes). values: number[]
export function Sparkline({ values, color = CH.primary, width = 120, height = 28 }: {
  values: number[]; color?: string; width?: number; height?: number;
}) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(values.length - 1) * step} cy={height - ((values[values.length - 1] - min) / span) * height}
        r={2} fill={color} />
    </svg>
  );
}
