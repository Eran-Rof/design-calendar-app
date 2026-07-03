// /ai-ops — operator-facing observability dashboard for Ask AI.
//
// Reads /api/internal/ai/ops-summary (which aggregates ip_ai_call_log +
// ip_ai_answer_cache) and renders stat tiles + tables. Helps the team
// answer "what is Ask AI costing us, who's using it, and where are
// the errors" without pawing through SQL.
//
// Auth: internal staff only via the existing /api/internal/* bearer
// pattern (installInternalApiAuth injects the header).

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "../../tanda/components/SearchableSelect";

const PAL = {
  bg: "#0F172A",
  panel: "#1E293B",
  panelAlt: "#162033",
  border: "#334155",
  text: "#F1F5F9",
  textDim: "#94A3B8",
  textMuted: "#6B7280",
  accent: "#3B82F6",
  green: "#10B981",
  yellow: "#F59E0B",
  red: "#EF4444",
} as const;

interface Summary {
  window: { days: number; from: string; to: string };
  totals: { calls: number; errors: number; input_tokens: number; output_tokens: number; cost_usd: number };
  per_handler: { handler: string; calls: number; cost_usd: number; error_count: number }[];
  per_day:     { date: string; calls: number; cost_usd: number }[];
  per_model:   { model: string; calls: number; cost_usd: number }[];
  cache:       { entries: number; total_hits: number; top_questions: { question: string; hit_count: number; last_hit_at: string | null }[] };
  recent_errors: { handler: string; error: string; called_at: string }[];
  generated_at: string;
}

function formatMoney(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
function formatNum(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return formatNum(n);
}
function formatDate(s: string): string {
  return new Date(s).toLocaleString();
}

function readPlmUserId(): string | null {
  try {
    const raw = sessionStorage.getItem("plm_user");
    if (!raw) return null;
    const u = JSON.parse(raw) as { id?: string } | null;
    return u?.id || null;
  } catch { return null; }
}

export default function OpsApp() {
  const userId = useMemo(() => readPlmUserId(), []);
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/internal/ai/ops-summary?days=${days}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setSummary(j);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [days]);

  if (!userId) {
    return (
      <div style={{ ...wrap, padding: 40, textAlign: "center" }}>
        Sign in to PLM first — <a href="/" style={{ color: PAL.accent }}>go to launcher</a>.
      </div>
    );
  }

  const maxDayCost = summary ? Math.max(0.001, ...summary.per_day.map(d => d.cost_usd)) : 0.001;
  const errorRate = summary && summary.totals.calls > 0
    ? (summary.totals.errors / summary.totals.calls) * 100
    : 0;
  const cacheHitRatio = summary && summary.totals.calls > 0
    ? summary.cache.total_hits / (summary.totals.calls + summary.cache.total_hits)
    : 0;

  return (
    <div style={wrap}>
      <header style={header}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <a href="/" style={{ color: PAL.textMuted, textDecoration: "none", fontSize: 13 }}>← PLM</a>
          <span style={{ fontWeight: 700, fontSize: 16, color: PAL.text }}>Ask AI — Operations</span>
          <span style={{ fontSize: 11, color: PAL.textMuted }}>(read-only telemetry — token spend, errors, cache hits)</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12, color: PAL.textDim }}>Window:</label>
          <SearchableSelect
            value={String(days)}
            onChange={v => setDays(Number(v))}
            options={[
              { value: "7", label: "Last 7 days" },
              { value: "14", label: "Last 14 days" },
              { value: "30", label: "Last 30 days" },
              { value: "60", label: "Last 60 days" },
              { value: "90", label: "Last 90 days" },
            ]}
            inputStyle={select}
          />
          <button onClick={load} style={btnSecondary}>Refresh</button>
        </div>
      </header>

      {error && (
        <div style={errorBox}>Failed to load: {error}</div>
      )}

      {loading && !summary ? (
        <div style={{ padding: 40, color: PAL.textDim, textAlign: "center" }}>Loading…</div>
      ) : !summary ? null : (
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Headline tiles */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Tile label="Calls"            value={formatNum(summary.totals.calls)} sub={`${summary.totals.errors} errors (${errorRate.toFixed(1)}%)`} />
            <Tile label="Cost"             value={formatMoney(summary.totals.cost_usd)}    sub={`${formatTokens(summary.totals.input_tokens + summary.totals.output_tokens)} tokens`} />
            <Tile label="Input tokens"     value={formatTokens(summary.totals.input_tokens)} />
            <Tile label="Output tokens"    value={formatTokens(summary.totals.output_tokens)} />
            <Tile label="Cache entries"    value={formatNum(summary.cache.entries)}        sub={`${formatNum(summary.cache.total_hits)} hits · ${(cacheHitRatio * 100).toFixed(0)}% hit ratio`} />
          </div>

          {/* Daily trend — simple inline bar chart from per_day */}
          <section style={card}>
            <SectionTitle>Cost trend — last {days} days</SectionTitle>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 80, marginTop: 12 }}>
              {summary.per_day.map(d => {
                const ratio = d.cost_usd / maxDayCost;
                return (
                  <div
                    key={d.date}
                    title={`${d.date} · ${formatMoney(d.cost_usd)} · ${d.calls} calls`}
                    style={{
                      flex: 1, minWidth: 3,
                      height: `${Math.max(2, Math.round(ratio * 80))}px`,
                      background: ratio > 0.6 ? PAL.yellow : PAL.accent,
                      borderRadius: 2,
                    }}
                  />
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: PAL.textMuted, marginTop: 4 }}>
              <span>{summary.per_day[0]?.date}</span>
              <span>{summary.per_day[summary.per_day.length - 1]?.date}</span>
            </div>
          </section>

          {/* Two-column: per-handler + per-model */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <section style={card}>
              <SectionTitle>By handler</SectionTitle>
              <Table
                rows={summary.per_handler}
                cols={[
                  { key: "handler",    label: "Handler", render: r => r.handler },
                  { key: "calls",      label: "Calls",   align: "right", render: r => formatNum(r.calls) },
                  { key: "cost_usd",   label: "Cost",    align: "right", render: r => formatMoney(r.cost_usd) },
                  { key: "error_count", label: "Errors", align: "right", render: r => r.error_count > 0 ? <span style={{ color: PAL.red }}>{r.error_count}</span> : <span style={{ color: PAL.textMuted }}>0</span> },
                ]}
              />
            </section>
            <section style={card}>
              <SectionTitle>By model</SectionTitle>
              <Table
                rows={summary.per_model}
                cols={[
                  { key: "model",    label: "Model" },
                  { key: "calls",    label: "Calls",   align: "right", render: r => formatNum(r.calls) },
                  { key: "cost_usd", label: "Cost",    align: "right", render: r => formatMoney(r.cost_usd) },
                ]}
              />
            </section>
          </div>

          {/* Top cached questions */}
          <section style={card}>
            <SectionTitle>Most-cached questions (top 10)</SectionTitle>
            <Table
              rows={summary.cache.top_questions}
              cols={[
                { key: "question", label: "Question", render: r => <span style={{ color: PAL.text }}>{r.question}</span> },
                { key: "hit_count", label: "Hits", align: "right", render: r => formatNum(r.hit_count) },
                { key: "last_hit_at", label: "Last hit", render: r => r.last_hit_at ? new Date(r.last_hit_at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }) : "—" },
              ]}
            />
          </section>

          {/* Recent errors */}
          {summary.recent_errors.length > 0 && (
            <section style={card}>
              <SectionTitle>Recent errors (last 20)</SectionTitle>
              <Table
                rows={summary.recent_errors}
                cols={[
                  { key: "called_at", label: "When",    render: r => formatDate(r.called_at) },
                  { key: "handler",   label: "Handler" },
                  { key: "error",     label: "Error",   render: r => <span style={{ color: PAL.red }}>{r.error}</span> },
                ]}
              />
            </section>
          )}

          <div style={{ fontSize: 11, color: PAL.textMuted, textAlign: "right" }}>
            Generated {new Date(summary.generated_at).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small reusable bits ─────────────────────────────────────────────────

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 8, padding: 14, minWidth: 160, flex: 1 }}>
      <div style={{ color: PAL.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color: PAL.text, fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ color: PAL.textDim, fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: PAL.text, textTransform: "uppercase", letterSpacing: 0.6 }}>
      {children}
    </h3>
  );
}

interface Col<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  render?: (row: T) => React.ReactNode;
}
function Table<T extends Record<string, any>>({ rows, cols }: { rows: T[]; cols: Col<T>[] }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: PAL.textDim, padding: 12, fontSize: 13 }}>No rows.</div>;
  }
  return (
    <div style={{ overflowX: "auto", marginTop: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} style={{
                padding: "8px 10px", textAlign: c.align === "right" ? "right" : "left",
                fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                color: PAL.textMuted, borderBottom: `1px solid ${PAL.border}`,
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: i > 0 ? `1px solid ${PAL.border}` : "none" }}>
              {cols.map(c => (
                <td key={c.key} style={{
                  padding: "8px 10px", color: PAL.text, fontSize: 12,
                  textAlign: c.align === "right" ? "right" : "left",
                  fontFamily: c.align === "right" ? "ui-monospace, SFMono-Regular, monospace" : "inherit",
                }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── styles ──────────────────────────────────────────────────────────────
const wrap: React.CSSProperties = {
  minHeight: "100vh", background: PAL.bg, color: PAL.text,
  fontFamily: "'DM Sans','Segoe UI',sans-serif",
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 24px", background: PAL.panel, borderBottom: `1px solid ${PAL.border}`,
};
const select: React.CSSProperties = {
  background: PAL.bg, color: PAL.text, border: `1px solid ${PAL.border}`,
  borderRadius: 6, padding: "6px 10px", fontSize: 12, fontFamily: "inherit",
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: PAL.textDim, border: `1px solid ${PAL.border}`,
  borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
};
const card: React.CSSProperties = {
  background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 8, padding: 16,
};
const errorBox: React.CSSProperties = {
  margin: "16px 24px", padding: "10px 14px",
  background: "#7F1D1D", color: "#FECACA", border: `1px solid ${PAL.red}`, borderRadius: 6, fontSize: 13,
};
