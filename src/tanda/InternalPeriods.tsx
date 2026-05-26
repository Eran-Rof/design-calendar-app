// src/tanda/InternalPeriods.tsx
//
// Tangerine P1 Chunk 8b — GL Periods admin panel.
// Read-only view of bootstrapped periods (FY 2021-2030 x 12 = 120 rows for ROF)
// grouped by fiscal_year, with per-period status transitions.
//
// Status flow:
//   open       → soft_close (block regular postings, allow adjustment/close)
//   open       → closed     (block all writes)
//   soft_close → closed
//   soft_close → open       (reopen)
//   closed     → soft_close (partial reopen)
//   closed     → open       (full reopen)

import { useEffect, useMemo, useState } from "react";

type Period = {
  id: string;
  fiscal_year: number;
  period_number: number;
  starts_on: string;
  ends_on: string;
  status: "open" | "soft_close" | "closed";
  soft_closed_at: string | null;
  closed_at: string | null;
  posted_je_count?: number;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const STATUS_COLORS: Record<Period["status"], string> = {
  open: C.success,
  soft_close: C.warn,
  closed: C.danger,
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
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

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function InternalPeriods() {
  const [rows, setRows] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fyFilter, setFyFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ include_counts: "true" });
      if (fyFilter) params.set("fiscal_year", fyFilter);
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetch(`/api/internal/gl-periods?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Period[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [fyFilter, statusFilter]);

  async function changeStatus(p: Period, next: Period["status"]) {
    if (next === p.status) return;
    if (!confirm(`Change FY${p.fiscal_year} period ${p.period_number} (${MONTH_LABELS[p.period_number - 1]}) from "${p.status}" to "${next}"?`)) return;
    try {
      const r = await fetch(`/api/internal/gl-periods/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      alert(`Status change failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Group rows by fiscal_year.
  const groups = useMemo(() => {
    const m = new Map<number, Period[]>();
    for (const p of rows) {
      const list = m.get(p.fiscal_year) ?? [];
      list.push(p);
      m.set(p.fiscal_year, list);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [rows]);

  const fyOptions = useMemo(() => {
    const s = new Set<number>();
    for (const p of rows) s.add(p.fiscal_year);
    return [...s].sort((a, b) => a - b);
  }, [rows]);

  return (
    <div style={{ color: C.text }}>
      <h2 style={{ margin: 0, fontSize: 22, marginBottom: 8 }}>Accounting Periods</h2>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: C.textSub }}>
        <strong style={{ color: C.text }}>Status flow:</strong>{" "}
        <span style={{ color: STATUS_COLORS.open }}>open</span> allows all postings.{" "}
        <span style={{ color: STATUS_COLORS.soft_close }}>soft_close</span> blocks regular journal entries but accepts adjustments and close entries.{" "}
        <span style={{ color: STATUS_COLORS.closed }}>closed</span> blocks all writes. Reopening transitions are allowed in all directions.
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <select value={fyFilter} onChange={(e) => setFyFilter(e.target.value)} style={inputStyle}>
          <option value="">All fiscal years</option>
          {fyOptions.map((y) => <option key={y} value={String(y)}>FY {y}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
          <option value="">All statuses</option>
          <option value="open">open</option>
          <option value="soft_close">soft_close</option>
          <option value="closed">closed</option>
        </select>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No periods match.</div>
      ) : groups.map(([year, list]) => <YearCard key={year} year={year} periods={list} onChangeStatus={changeStatus} />)}
    </div>
  );
}

function YearCard({ year, periods, onChangeStatus }: { year: number; periods: Period[]; onChangeStatus: (p: Period, next: Period["status"]) => void }) {
  const summary = useMemo(() => {
    let open = 0, soft = 0, closed = 0;
    for (const p of periods) {
      if (p.status === "open") open++;
      else if (p.status === "soft_close") soft++;
      else if (p.status === "closed") closed++;
    }
    return { open, soft, closed };
  }, [periods]);

  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, marginBottom: 16, overflow: "hidden" }}>
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>FY {year}</h3>
        <div style={{ fontSize: 12, color: C.textMuted }}>
          <span style={{ color: STATUS_COLORS.open }}>{summary.open} open</span>
          {" · "}
          <span style={{ color: STATUS_COLORS.soft_close }}>{summary.soft} soft_close</span>
          {" · "}
          <span style={{ color: STATUS_COLORS.closed }}>{summary.closed} closed</span>
        </div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Period</th>
            <th style={th}>Starts</th>
            <th style={th}>Ends</th>
            <th style={th}>Posted JEs</th>
            <th style={th}>Status</th>
            <th style={{ ...th, width: 240 }}>Change to</th>
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.id}>
              <td style={td}>{p.period_number} — {MONTH_LABELS[p.period_number - 1]}</td>
              <td style={td}>{p.starts_on}</td>
              <td style={td}>{p.ends_on}</td>
              <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{p.posted_je_count ?? 0}</td>
              <td style={td}>
                <span style={{ color: STATUS_COLORS[p.status], fontWeight: 600 }}>● {p.status}</span>
              </td>
              <td style={td}>
                <select
                  value={p.status}
                  onChange={(e) => onChangeStatus(p, e.target.value as Period["status"])}
                  style={inputStyle as React.CSSProperties}
                >
                  <option value="open">open</option>
                  <option value="soft_close">soft_close</option>
                  <option value="closed">closed</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
