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

type PeriodStatus = "open" | "soft_close" | "closed" | "closed_with_closing_jes";

type Period = {
  id: string;
  fiscal_year: number;
  period_number: number;
  starts_on: string;
  ends_on: string;
  status: PeriodStatus;
  soft_closed_at: string | null;
  closed_at: string | null;
  posted_je_count?: number;
};

type PreflightRow = {
  check_name: string;
  status: "pass" | "fail";
  detail: string;
  blocking: boolean;
};

type PreflightResponse = {
  period_id: string;
  rows: PreflightRow[];
  summary: { total: number; passed: number; failed_blocking: number; failed_warnings: number; can_close: boolean };
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const STATUS_COLORS: Record<PeriodStatus, string> = {
  open: C.success,
  soft_close: C.warn,
  closed: C.danger,
  closed_with_closing_jes: "#6b7280",  // gray — terminal
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
  // Default to the current calendar year so the panel doesn't dump all 10
  // bootstrapped fiscal years on the operator. Switch to "All" via the dropdown.
  const [fyFilter, setFyFilter] = useState(String(new Date().getFullYear()));
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

  const [preflight, setPreflight] = useState<{ period: Period; data: PreflightResponse | null; loading: boolean; err: string | null } | null>(null);

  async function softClose(p: Period) {
    if (!confirm(`Soft-close FY${p.fiscal_year} period ${p.period_number} (${MONTH_LABELS[p.period_number - 1]})? Pre-flight checks run automatically.`)) return;
    await postClose(p, "soft_close");
  }

  async function hardClose(p: Period) {
    if (!confirm(`HARD-close FY${p.fiscal_year} period ${p.period_number}? Blocks all posting until reopened.`)) return;
    await postClose(p, "closed");
  }

  async function postClose(p: Period, target: "soft_close" | "closed") {
    try {
      const r = await fetch(`/api/internal/gl-periods/${p.id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_status: target }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (data.blocking_failures) {
          alert(`Close blocked by pre-flight checks:\n\n${data.blocking_failures.map((f: PreflightRow) => `• ${f.check_name}: ${f.detail}`).join("\n")}`);
        } else {
          alert(`Close failed: ${data.error || `HTTP ${r.status}`}`);
        }
        return;
      }
      if (data.requires_approval) {
        alert(`Close requires approval — request ${data.approval_request_id}. Visit Approvals Inbox to approve.`);
      }
      await load();
    } catch (e: unknown) {
      alert(`Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function reopen(p: Period) {
    const reason = prompt(`Reopen FY${p.fiscal_year} period ${p.period_number}? Operator notes (required):`);
    if (!reason || !reason.trim()) return;
    const actorPrompt = prompt("Your auth_user_id (UUID, admin role required):");
    if (!actorPrompt || !actorPrompt.trim()) return;
    try {
      const r = await fetch(`/api/internal/gl-periods/${p.id}/reopen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_user_id: actorPrompt.trim(), reason: reason.trim() }),
      });
      const data = await r.json();
      if (!r.ok) {
        alert(`Reopen failed: ${data.error || `HTTP ${r.status}`}`);
        return;
      }
      await load();
    } catch (e: unknown) {
      alert(`Reopen failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function runChecks(p: Period) {
    setPreflight({ period: p, data: null, loading: true, err: null });
    try {
      const r = await fetch(`/api/internal/gl-periods/${p.id}/preflight`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setPreflight({ period: p, data: data as PreflightResponse, loading: false, err: null });
    } catch (e: unknown) {
      setPreflight((s) => s ? { ...s, loading: false, err: e instanceof Error ? e.message : String(e) } : null);
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
      ) : groups.map(([year, list]) => (
        <YearCard
          key={year}
          year={year}
          periods={list}
          onSoftClose={softClose}
          onHardClose={hardClose}
          onReopen={reopen}
          onRunChecks={runChecks}
        />
      ))}

      {preflight && (
        <PreflightModal
          period={preflight.period}
          data={preflight.data}
          loading={preflight.loading}
          err={preflight.err}
          onClose={() => setPreflight(null)}
        />
      )}
    </div>
  );
}

type YearCardProps = {
  year: number;
  periods: Period[];
  onSoftClose: (p: Period) => void;
  onHardClose: (p: Period) => void;
  onReopen:    (p: Period) => void;
  onRunChecks: (p: Period) => void;
};

const btnAction: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 11,
  marginRight: 4,
};
const btnActionDanger: React.CSSProperties = { ...btnAction, color: C.danger, borderColor: "#7f1d1d" };
const btnActionWarn: React.CSSProperties = { ...btnAction, color: C.warn, borderColor: "#78350f" };

function YearCard({ year, periods, onSoftClose, onHardClose, onReopen, onRunChecks }: YearCardProps) {
  const summary = useMemo(() => {
    let open = 0, soft = 0, closed = 0, terminal = 0;
    for (const p of periods) {
      if (p.status === "open") open++;
      else if (p.status === "soft_close") soft++;
      else if (p.status === "closed") closed++;
      else if (p.status === "closed_with_closing_jes") terminal++;
    }
    return { open, soft, closed, terminal };
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
          {summary.terminal > 0 && (
            <>{" · "}<span style={{ color: STATUS_COLORS.closed_with_closing_jes }}>{summary.terminal} terminal</span></>
          )}
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
            <th style={{ ...th, width: 320 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => {
            const isTerminal = p.status === "closed_with_closing_jes";
            return (
              <tr key={p.id}>
                <td style={td}>{p.period_number} — {MONTH_LABELS[p.period_number - 1]}</td>
                <td style={td}>{p.starts_on}</td>
                <td style={td}>{p.ends_on}</td>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{p.posted_je_count ?? 0}</td>
                <td style={td}>
                  <span style={{ color: STATUS_COLORS[p.status], fontWeight: 600 }}>● {p.status}</span>
                </td>
                <td style={td}>
                  {isTerminal ? (
                    <span style={{ color: C.textMuted, fontSize: 11, fontStyle: "italic" }}>terminal — set by year-end close</span>
                  ) : (
                    <>
                      <button onClick={() => onRunChecks(p)} style={btnAction} title="Run pre-flight checks">Run checks</button>
                      {p.status === "open" && (
                        <button onClick={() => onSoftClose(p)} style={btnActionWarn} title="Block manual JEs but allow AP/AR">Soft close</button>
                      )}
                      {p.status === "soft_close" && (
                        <button onClick={() => onHardClose(p)} style={btnActionDanger} title="Block all postings">Close</button>
                      )}
                      {(p.status === "soft_close" || p.status === "closed") && (
                        <button onClick={() => onReopen(p)} style={btnAction} title="Reopen (admin only; reason required)">Reopen</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight modal — surfaces gl_period_close_preflight rows.
// ─────────────────────────────────────────────────────────────────────────────
function PreflightModal({ period, data, loading, err, onClose }: {
  period: Period;
  data: PreflightResponse | null;
  loading: boolean;
  err: string | null;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 560, maxWidth: 720, maxHeight: "85vh", overflowY: "auto", color: C.text }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>
            Pre-flight checks — FY{period.fiscal_year} {MONTH_LABELS[period.period_number - 1]}
          </h3>
          <button onClick={onClose} style={btnAction}>Close</button>
        </div>
        {loading && <div style={{ color: C.textMuted, padding: 12 }}>Loading…</div>}
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}
        {data && (
          <>
            <div style={{ marginBottom: 12, fontSize: 12, color: C.textSub }}>
              <strong style={{ color: data.summary.can_close ? C.success : C.danger }}>
                {data.summary.can_close ? "✓ Can close" : "✗ Blocked"}
              </strong>
              {" · "}
              {data.summary.passed} passed
              {data.summary.failed_blocking > 0 && <> · <span style={{ color: C.danger }}>{data.summary.failed_blocking} blocking</span></>}
              {data.summary.failed_warnings > 0 && <> · <span style={{ color: C.warn }}>{data.summary.failed_warnings} warnings</span></>}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={th}></th>
                  <th style={th}>Check</th>
                  <th style={th}>Detail</th>
                  <th style={{ ...th, width: 80 }}>Severity</th>
                </tr>
              </thead>
              <tbody>
                {(data.rows || []).map((r, i) => {
                  const ok = r.status === "pass";
                  const color = ok ? C.success : r.blocking ? C.danger : C.warn;
                  return (
                    <tr key={i}>
                      <td style={{ ...td, color, fontWeight: 700, fontSize: 14, textAlign: "center", width: 30 }}>
                        {ok ? "✓" : r.blocking ? "✗" : "⚠"}
                      </td>
                      <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }}>{r.check_name}</td>
                      <td style={{ ...td, color: ok ? C.textSub : color }}>{r.detail}</td>
                      <td style={{ ...td, color, fontSize: 11 }}>{r.blocking ? "blocking" : "warning"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
