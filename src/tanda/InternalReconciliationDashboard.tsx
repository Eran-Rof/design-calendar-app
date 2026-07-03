// src/tanda/InternalReconciliationDashboard.tsx
//
// Tangerine P9-7 — Parallel-Run Reconciliation Dashboard.
//
// Operator-facing single panel that wires together the read-only API
// surface from P9-1..P9-6:
//
//   • Top: 5 domain status cards (AP / AR / Cash / GL / Inventory) showing
//     the last recon run per domain + variance count + a "Run now" button
//     (currently wired to /api/internal/recon/run-inventory; other domain
//     manual triggers ship in later P9 chunks).
//
//   • Date range filter via <DateRangePresets /> (T7). Defaults to the
//     last 30 days. Drives the runs-list fetch.
//
//   • Status grid: rows = domain, cols = dates in range. Each cell is
//     color-coded by recon_runs.status (clean / variance / error / pending
//     / running). Clicking a cell opens the variance side panel for that
//     run.
//
//   • Variance side panel: lists recon_variances for the selected run
//     with source/scope/amount/variance + <SourceBadge /> per T10-7. Each
//     row has a "Clear…" button that opens an audit-reason modal
//     (D3 audit pattern — reason is REQUIRED per the P9-1 schema NOT NULL
//     constraint). Cleared variances flip to status='cleared' inline.
//
//   • <ExportButton /> (xlsx-only per T8) for the variance list when the
//     side panel is open.
//
//   • Cutover history table at the bottom: read-only list of
//     recon_cutover_signoffs across all domains. Rendered last so the
//     dashboard surface is operationally action-first.
//
// All cross-cutter components (DateRangePresets, ExportButton,
// SourceBadge) come from the existing cross-cutter modules.

import { useEffect, useMemo, useState } from "react";
import DateRangePresets from "./components/DateRangePresets";
import { computePreset } from "./components/dateRangeMath";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SourceBadge from "./components/SourceBadge";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const CUTOVER_TABLE_KEY = "tanda.recon_cutover_history";
const CUTOVER_COLUMNS: ColumnDef[] = [
  { key: "domain",       label: "Domain" },
  { key: "source_tag",   label: "Source tag" },
  { key: "clean_window", label: "Clean window" },
  { key: "total_recons", label: "Total recons" },
  { key: "signoff_emp",  label: "Signoff employee" },
  { key: "signoff_at",   label: "Signed off at" },
];

// ─────────────────────────────────────────────────────────────────────────
// Theme — match the existing Tangerine internal panels (Bank Rec / Shadow
// Mirror).
// ─────────────────────────────────────────────────────────────────────────
const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B",
  danger: "#EF4444", purple: "#A855F7", tangerine: "#fb923c",
};

// Map recon_runs.status → cell color. 'clean' is green, 'variance' red,
// 'error' yellow, anything else (pending / running) blue / gray.
const STATUS_COLOR: Record<string, string> = {
  clean:    C.success,
  variance: C.danger,
  error:    C.warn,
  running:  C.primary,
  pending:  C.textMuted,
};

export const DOMAINS = ["ap", "ar", "cash", "gl", "inventory"] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABEL: Record<Domain, string> = {
  ap:        "AP",
  ar:        "AR",
  cash:      "Cash",
  gl:        "GL",
  inventory: "Inventory",
};

export const DOMAIN_EMOJI: Record<Domain, string> = {
  ap:        "",
  ar:        "",
  cash:      "",
  gl:        "",
  inventory: "",
};

// Which manual-trigger endpoints exist today (built in P9-2..P9-6 —
// only h484=run-inventory has shipped on this chain). Other domains
// surface a "engine handler not yet wired" tooltip on the Run-now btn.
export const RUN_ENDPOINTS: Partial<Record<Domain, string>> = {
  inventory: "/api/internal/recon/run-inventory",
};

// ─────────────────────────────────────────────────────────────────────────
// API row types
// ─────────────────────────────────────────────────────────────────────────
export type ReconRun = {
  id: string;
  entity_id: string;
  domain: Domain;
  run_date: string;
  period_start: string;
  period_end: string;
  cadence: "weekly" | "manual" | "replay";
  status: "pending" | "running" | "clean" | "variance" | "error";
  started_at: string | null;
  completed_at: string | null;
  totals_jsonb: Record<string, unknown>;
  replay_of_id: string | null;
  replay_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ReconVariance = {
  id: string;
  recon_run_id: string;
  source_table: string;
  source_id: string;
  source_tag: string | null;
  tangerine_amount_cents: number;
  xoro_amount_cents: number;
  variance_amount_cents: number;
  variance_percent: number | null;
  status: "within" | "over" | "cleared" | "suppressed";
  notes: string | null;
  created_at: string;
};

export type ReconCutover = {
  id: string;
  entity_id: string;
  domain: string;
  source_tag: string | null;
  clean_window_start: string;
  clean_window_end: string;
  total_recons: number;
  signoff_employee_id: string | null;
  signoff_at: string;
  notes: string | null;
};

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for unit tests.
// ─────────────────────────────────────────────────────────────────────────

/** Build the GET /api/internal/recon/runs URL with all current filters. */
export function buildRunsQuery(f: {
  domain?: Domain | null;
  from: string;
  to: string;
  limit?: number;
  offset?: number;
}): URLSearchParams {
  const p = new URLSearchParams();
  if (f.domain) p.set("domain", f.domain);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.limit != null) p.set("limit", String(f.limit));
  if (f.offset != null) p.set("offset", String(f.offset));
  return p;
}

/** Build the GET /api/internal/recon/variances URL for a given run. */
export function buildVariancesQuery(f: {
  recon_run_id: string;
  status?: string | null;
  source_tag?: string | null;
}): URLSearchParams {
  const p = new URLSearchParams();
  p.set("recon_run_id", f.recon_run_id);
  if (f.status) p.set("status", f.status);
  if (f.source_tag) p.set("source_tag", f.source_tag);
  return p;
}

/**
 * Index a list of runs into a (domain, run_date) → ReconRun lookup map
 * so the status grid can resolve each cell in O(1).
 */
export function indexRunsByDomainDate(
  runs: ReconRun[],
): Record<Domain, Record<string, ReconRun>> {
  const out: Record<Domain, Record<string, ReconRun>> = {
    ap: {}, ar: {}, cash: {}, gl: {}, inventory: {},
  };
  for (const r of runs) {
    if (!DOMAINS.includes(r.domain)) continue;
    const slot = out[r.domain];
    const existing = slot[r.run_date];
    // If there are multiple runs for the same (domain, run_date) — e.g.
    // a replay re-running an older date — keep the most recent by
    // updated_at so the dashboard reflects current state.
    if (!existing || (r.updated_at || "") > (existing.updated_at || "")) {
      slot[r.run_date] = r;
    }
  }
  return out;
}

/**
 * Pick the most-recent run per domain (used by the 5 status cards).
 */
export function latestRunPerDomain(
  runs: ReconRun[],
): Partial<Record<Domain, ReconRun>> {
  const out: Partial<Record<Domain, ReconRun>> = {};
  for (const r of runs) {
    if (!DOMAINS.includes(r.domain)) continue;
    const existing = out[r.domain];
    if (!existing || r.run_date > existing.run_date) {
      out[r.domain] = r;
    }
  }
  return out;
}

/**
 * Variance count for a single recon run, pulled from totals_jsonb.
 * Falls back to 0 when the field isn't set yet.
 */
export function varianceCount(run: ReconRun | undefined | null): number {
  if (!run) return 0;
  const t = run.totals_jsonb as Record<string, unknown> | null | undefined;
  if (!t) return 0;
  const v = t.variances_found ?? t.variances_over ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format integer cents to $ display string. Used by status cards + side
 * panel rows. NULL inputs render as "—" so missing-side variances don't
 * crash the dashboard.
 */
export function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const n = Number(cents);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n / 100);
}

/**
 * Build a list of date strings between from / to inclusive (descending),
 * for the columns of the status grid. Returns at most 60 dates to keep
 * the table width bounded — beyond 60 the grid switches to a "wider
 * range — use Export" hint (handled by the dashboard render path).
 */
export function buildDateRange(from: string, to: string, cap = 60): string[] {
  if (!from || !to) return [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
  if (end < start) return [];
  const out: string[] = [];
  const cursor = new Date(end.getTime());
  while (cursor >= start && out.length < cap) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() - 1);
  }
  return out;
}

/** Convert one variance row into the flat shape ExportButton expects. */
export function flattenVarianceForExport(v: ReconVariance): Record<string, unknown> {
  return {
    id: v.id,
    source_table: v.source_table,
    source_id: v.source_id,
    source_tag: v.source_tag || "",
    tangerine_dollars: v.tangerine_amount_cents == null ? null : v.tangerine_amount_cents / 100,
    xoro_dollars:      v.xoro_amount_cents == null ? null : v.xoro_amount_cents / 100,
    variance_dollars:  v.variance_amount_cents == null ? null : v.variance_amount_cents / 100,
    variance_percent:  v.variance_percent,
    status:            v.status,
    notes:             v.notes || "",
    created_at:        v.created_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Inline styles — match the rest of the Tangerine internal panels.
// ─────────────────────────────────────────────────────────────────────────
const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "6px 12px",
  borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = {
  background: C.danger, color: "white", border: 0, padding: "4px 10px",
  borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle, fontFamily: "inherit", width: "100%", minHeight: 80,
  resize: "vertical",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 12,
};

// ─────────────────────────────────────────────────────────────────────────
// Date defaults — "last 30 days" via the cross-cutter helper so the chip
// shows as the active one on mount.
// ─────────────────────────────────────────────────────────────────────────
function defaultRange(): { from: string; to: string } {
  // computePreset("last30days") returns the canonical range as YYYY-MM-DD.
  try {
    const v = computePreset("last30days");
    if (v && v.from && v.to) return { from: v.from, to: v.to };
  } catch {
    // fall through to manual computation below
  }
  const today = new Date();
  const to = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const start = new Date(today.getTime());
  start.setDate(start.getDate() - 29);
  const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  return { from, to };
}

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────
export default function InternalReconciliationDashboard() {
  const [{ from, to }, setRange] = useState<{ from: string; to: string }>(defaultRange);
  const [runs, setRuns] = useState<ReconRun[]>([]);
  const [cutovers, setCutovers] = useState<ReconCutover[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Side panel state — which run is being drilled into + its variances.
  const [selectedRun, setSelectedRun] = useState<ReconRun | null>(null);
  const [variances, setVariances] = useState<ReconVariance[]>([]);
  const [variancesLoading, setVariancesLoading] = useState(false);
  const [variancesErr, setVariancesErr] = useState<string | null>(null);

  // Clear-reason modal state — D3 audit pattern requires the reason.
  const [clearTarget, setClearTarget] = useState<ReconVariance | null>(null);

  // Run-now trigger state — keeps the button disabled while a request
  // is in flight so the operator can't double-fire.
  const [running, setRunning] = useState<Domain | null>(null);

  // Column visibility for the cutover-history table (operator ask #1).
  const cutoverPrefs = useTablePrefs(CUTOVER_TABLE_KEY, CUTOVER_COLUMNS);
  const cutoverVisible = cutoverPrefs.visibleColumns;

  // Tri-state column sort for the cutover-history LIST table (#5). Derived
  // keys: clean_window sorts by window start; signoff_emp by signed/blank.
  const {
    sorted: sortedCutovers,
    sortKey: cutoverSortKey,
    sortDir: cutoverSortDir,
    onHeaderClick: onCutoverSort,
  } = useSort(cutovers, {
    persistKey: "tangerine:recon-cutover:sort",
    accessors: {
      clean_window: (c) => c.clean_window_start,
      signoff_emp: (c) => (c.signoff_employee_id ? 1 : 0),
      signoff_at: (c) => c.signoff_at,
    },
  });

  async function loadRuns() {
    setLoading(true); setErr(null);
    try {
      const q = buildRunsQuery({ from, to, limit: 1000 });
      const r = await fetch(`/api/internal/recon/runs?${q.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRuns(Array.isArray(j.runs) ? (j.runs as ReconRun[]) : []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadCutovers() {
    try {
      const r = await fetch(`/api/internal/recon/cutovers?limit=200`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Don't bubble the cutover error to the main banner — the recon
        // grid still works without the audit table.
        return;
      }
      setCutovers(Array.isArray(j.cutovers) ? (j.cutovers as ReconCutover[]) : []);
    } catch {
      // ignore — non-critical surface
    }
  }

  async function loadVariances(run: ReconRun) {
    setVariancesLoading(true); setVariancesErr(null);
    try {
      const q = buildVariancesQuery({ recon_run_id: run.id });
      const r = await fetch(`/api/internal/recon/variances?${q.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setVariances(Array.isArray(j.variances) ? (j.variances as ReconVariance[]) : []);
    } catch (e: unknown) {
      setVariancesErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVariancesLoading(false);
    }
  }

  useEffect(() => { void loadRuns(); void loadCutovers(); }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = useMemo(() => latestRunPerDomain(runs), [runs]);
  const byDomainDate = useMemo(() => indexRunsByDomainDate(runs), [runs]);
  const dates = useMemo(() => buildDateRange(from, to, 60), [from, to]);
  const dateRangeTooWide = useMemo(() => {
    if (!from || !to) return false;
    const a = new Date(`${from}T00:00:00`);
    const b = new Date(`${to}T00:00:00`);
    const ms = b.getTime() - a.getTime();
    return ms / 86_400_000 > 59;
  }, [from, to]);

  async function runNow(d: Domain) {
    const endpoint = RUN_ENDPOINTS[d];
    if (!endpoint) return;
    setRunning(d);
    try {
      // The Inventory engine wants explicit period start/end. Default to
      // the current viewing window — operator typically rebuilds the
      // window they were just looking at.
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period_start: from,
          period_end: to,
          cadence: "manual",
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(`Run failed (${d}): ${j.error || `HTTP ${r.status}`}`);
      }
      await loadRuns();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  async function clearVariance(v: ReconVariance, reason: string) {
    const r = await fetch(`/api/internal/recon/variances/${encodeURIComponent(v.id)}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    // Reflect the new status in the local cache so the row visibly
    // turns "cleared" without a full reload.
    setVariances((prev) =>
      prev.map((x) => (x.id === v.id ? { ...x, status: "cleared" as const } : x)),
    );
  }

  function openRunDetail(run: ReconRun) {
    setSelectedRun(run);
    void loadVariances(run);
  }

  return (
    <div style={{ color: C.text }} data-testid="recon-dashboard">
      {/* ───── Header ───── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Parallel-Run Reconciliation</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>
            5-domain recon · Xoro vs Tangerine · soft-block close until cleared (D4)
          </span>
          <button onClick={() => void loadRuns()} style={btnSecondary} data-testid="recon-refresh">Refresh</button>
        </div>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }} data-testid="recon-error">
          {err}
        </div>
      )}

      {/* ───── Top 5 domain status cards ───── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 18 }}>
        {DOMAINS.map((d) => {
          const run = latest[d];
          const vc = varianceCount(run);
          const color = run ? (STATUS_COLOR[run.status] || C.textMuted) : C.cardBdr;
          const canRun = !!RUN_ENDPOINTS[d];
          return (
            <div
              key={d}
              style={{
                background: C.card,
                border: `1px solid ${C.cardBdr}`,
                borderLeft: `3px solid ${color}`,
                borderRadius: 10,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
              data-testid={`recon-card-${d}`}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{DOMAIN_LABEL[d]}</span>
              </div>
              {run ? (
                <>
                  <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Last run · {run.run_date}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color }}>
                    ● {run.status}
                  </div>
                  <div style={{ fontSize: 11, color: C.textSub }}>
                    <strong style={{ color: vc > 0 ? C.danger : C.text }}>{vc}</strong> variance{vc === 1 ? "" : "s"}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic" }}>
                  {loading ? "Loading…" : "No run yet"}
                </div>
              )}
              <button
                onClick={() => void runNow(d)}
                disabled={!canRun || running === d}
                style={{
                  ...btnPrimary,
                  opacity: canRun && running !== d ? 1 : 0.5,
                  cursor: canRun && running !== d ? "pointer" : "not-allowed",
                  marginTop: 4,
                }}
                title={canRun ? "Trigger the manual recon engine for this domain" : "Engine handler not yet wired (P9-2..P9-5)"}
                data-testid={`recon-run-now-${d}`}
              >
                {running === d ? "Running…" : "Run now"}
              </button>
            </div>
          );
        })}
      </div>

      {/* ───── Date range filter ───── */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 12, marginBottom: 18, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Date range
        </div>
        <input
          type="date"
          value={from}
          onChange={(e) => setRange((p) => ({ ...p, from: e.target.value }))}
          style={inputStyle}
          data-testid="recon-from"
        />
        <span style={{ color: C.textMuted, fontSize: 12 }}>→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setRange((p) => ({ ...p, to: e.target.value }))}
          style={inputStyle}
          data-testid="recon-to"
        />
        <DateRangePresets variant="dropdown"
          from={from}
          to={to}
          onChange={(f, t) => setRange({ from: f, to: t })}
        />
      </div>

      {/* ───── Status grid ───── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
          Status grid · domain × date
        </h3>
        {dateRangeTooWide && (
          <div style={{ fontSize: 11, color: C.warn }}>
            Range exceeds 60 days — grid capped at the 60 most recent.
          </div>
        )}
      </div>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)", marginBottom: 24 }} data-testid="recon-grid-wrap">
        {loading ? (
          <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>Loading…</div>
        ) : dates.length === 0 ? (
          <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>No dates in range.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }} data-testid="recon-grid">
            <thead>
              <tr>
                <th style={{ ...th, width: 110, position: "sticky", left: 0, background: "#0b1220", zIndex: 1 }}>Domain</th>
                {dates.map((d) => (
                  <th key={d} style={{ ...th, textAlign: "center", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {d.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DOMAINS.map((dom) => (
                <tr key={dom}>
                  <td style={{ ...td, fontWeight: 600, position: "sticky", left: 0, background: C.card, zIndex: 1 }}>
                    {DOMAIN_LABEL[dom]}
                  </td>
                  {dates.map((date) => {
                    const cell = byDomainDate[dom][date];
                    const color = cell ? (STATUS_COLOR[cell.status] || C.textMuted) : "#475569";
                    const label = cell ? cell.status : "—";
                    return (
                      <td
                        key={date}
                        style={{ ...td, textAlign: "center", cursor: cell ? "pointer" : "default", padding: "4px 6px" }}
                        onClick={() => cell && openRunDetail(cell)}
                        title={cell ? `${cell.status} · click to drill in` : "No run"}
                        data-testid={`recon-cell-${dom}-${date}`}
                      >
                        <span
                          style={{
                            display: "inline-block",
                            minWidth: 56,
                            padding: "2px 6px",
                            borderRadius: 12,
                            background: cell ? color : "transparent",
                            color: cell ? "white" : C.textMuted,
                            border: cell ? "none" : `1px dashed ${C.cardBdr}`,
                            fontSize: 10,
                            fontWeight: 600,
                          }}
                        >
                          {label}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ───── Cutover history table ───── */}
      <div style={{ marginBottom: 24 }} data-testid="recon-cutover-history">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
            Cutover history · D8 sign-offs
          </h3>
          <TablePrefsButton
            tableKey={CUTOVER_TABLE_KEY}
            columns={CUTOVER_COLUMNS}
            visibleColumns={cutoverVisible}
            onToggle={cutoverPrefs.toggleColumn}
            onReset={cutoverPrefs.resetToDefault}
            onSetAll={cutoverPrefs.setAllVisible}
          />
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
          {cutovers.length === 0 ? (
            <div style={{ padding: 20, color: C.textMuted, textAlign: "center", fontSize: 12 }}>
              No cutover sign-offs yet — every domain is still parallel-running.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }} data-testid="recon-cutover-table">
              <thead>
                <tr>
                  <SortableTh label="Domain" sortKey="domain" activeKey={cutoverSortKey} dir={cutoverSortDir} onSort={onCutoverSort} style={th} hidden={!cutoverVisible.has("domain")} />
                  <SortableTh label="Source tag" sortKey="source_tag" activeKey={cutoverSortKey} dir={cutoverSortDir} onSort={onCutoverSort} style={th} hidden={!cutoverVisible.has("source_tag")} />
                  <SortableTh label="Clean window" sortKey="clean_window" activeKey={cutoverSortKey} dir={cutoverSortDir} onSort={onCutoverSort} style={th} hidden={!cutoverVisible.has("clean_window")} />
                  <SortableTh label="Total recons" sortKey="total_recons" activeKey={cutoverSortKey} dir={cutoverSortDir} onSort={onCutoverSort} style={th} hidden={!cutoverVisible.has("total_recons")} />
                  <SortableTh label="Signoff employee" sortKey="signoff_emp" activeKey={cutoverSortKey} dir={cutoverSortDir} onSort={onCutoverSort} style={th} hidden={!cutoverVisible.has("signoff_emp")} />
                  <SortableTh label="Signed off at" sortKey="signoff_at" activeKey={cutoverSortKey} dir={cutoverSortDir} onSort={onCutoverSort} style={th} hidden={!cutoverVisible.has("signoff_at")} />
                </tr>
              </thead>
              <tbody>
                {sortedCutovers.map((c) => (
                  <tr key={c.id} data-testid={`recon-cutover-row-${c.id}`}>
                    <td style={td} hidden={!cutoverVisible.has("domain")}><strong>{c.domain}</strong></td>
                    <td style={td} hidden={!cutoverVisible.has("source_tag")}>
                      {c.source_tag ? <SourceBadge source={c.source_tag} /> : <span style={{ color: C.textMuted }}>—</span>}
                    </td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }} hidden={!cutoverVisible.has("clean_window")}>
                      {c.clean_window_start} → {c.clean_window_end}
                    </td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }} hidden={!cutoverVisible.has("total_recons")}>{c.total_recons}</td>
                    <td style={td} hidden={!cutoverVisible.has("signoff_emp")}>
                      {c.signoff_employee_id ? "✓ Signed off" : "—"}
                    </td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }} hidden={!cutoverVisible.has("signoff_at")}>
                      {new Date(c.signoff_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ───── Variance side panel ───── */}
      {selectedRun && (
        <VarianceSidePanel
          run={selectedRun}
          variances={variances}
          loading={variancesLoading}
          err={variancesErr}
          onClose={() => { setSelectedRun(null); setVariances([]); setVariancesErr(null); }}
          onClear={(v) => setClearTarget(v)}
        />
      )}

      {/* ───── Clear-reason modal (D3 audit pattern — REQUIRED reason) ───── */}
      {clearTarget && (
        <ClearReasonModal
          variance={clearTarget}
          onCancel={() => setClearTarget(null)}
          onConfirm={async (reason) => {
            await clearVariance(clearTarget, reason);
            setClearTarget(null);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Variance side panel — slides in from the right with the variance list,
// per-row Clear button, ExportButton, and per-amount diff.
// ─────────────────────────────────────────────────────────────────────────
function VarianceSidePanel({
  run, variances, loading, err, onClose, onClear,
}: {
  run: ReconRun;
  variances: ReconVariance[];
  loading: boolean;
  err: string | null;
  onClose: () => void;
  onClear: (v: ReconVariance) => void;
}) {
  const exportRows = useMemo(() => {
    const flat = variances.map(flattenVarianceForExport);
    if (flat.length === 0) return flat;
    // #23 — append a TOTAL row summing the numeric dollar / percent columns;
    // all non-numeric columns stay blank except the leading TOTAL marker.
    const sum = (k: string) =>
      flat.reduce((acc, r) => acc + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
    const totalRow: Record<string, unknown> = {
      id: "TOTAL",
      source_table: "",
      source_id: "",
      source_tag: "",
      tangerine_dollars: sum("tangerine_dollars"),
      xoro_dollars: sum("xoro_dollars"),
      variance_dollars: sum("variance_dollars"),
      variance_percent: sum("variance_percent"),
      status: "",
      notes: "",
      created_at: "",
    };
    return [...flat, totalRow];
  }, [variances]);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", justifyContent: "flex-end", zIndex: 100 }}
      data-testid="recon-side-panel"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`, borderLeft: `3px solid ${C.primary}`,
          padding: 20, width: "min(95vw, 900px)", maxHeight: "100vh", overflowY: "auto", color: C.text,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>
            {DOMAIN_LABEL[run.domain]} variances — {run.run_date}
          </h3>
          <button onClick={onClose} style={btnSecondary} data-testid="recon-side-panel-close">Close</button>
        </div>

        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
          Run ID: <span style={{ fontFamily: "monospace" }}>{run.id}</span>
          {" · "}
          Status: <span style={{ color: STATUS_COLOR[run.status] || C.text, fontWeight: 600 }}>{run.status}</span>
          {" · "}
          Period: {run.period_start} → {run.period_end}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <ExportButton
            rows={exportRows as unknown as Array<Record<string, unknown>>}
            filename={`recon-${run.domain}-${run.run_date}`}
            sheetName="Variances"
            columns={[
              { key: "id",                header: "Variance ID" },
              { key: "source_table",      header: "Source Table" },
              { key: "source_id",         header: "Source ID" },
              { key: "source_tag",        header: "Source Tag" },
              { key: "tangerine_dollars", header: "Tangerine $",  format: "currency" },
              { key: "xoro_dollars",      header: "Xoro $",       format: "currency" },
              { key: "variance_dollars",  header: "Variance $",   format: "currency" },
              { key: "variance_percent",  header: "Variance %",   format: "number" },
              { key: "status",            header: "Status" },
              { key: "notes",             header: "Notes" },
              { key: "created_at",        header: "Created",      format: "date" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }} data-testid="recon-side-panel-error">
            {err}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>Loading…</div>
        ) : variances.length === 0 ? (
          <div style={{ padding: 20, color: C.success, textAlign: "center", fontSize: 13 }}>
            ✓ No variances recorded for this run.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }} data-testid="recon-variance-table">
            <thead>
              <tr>
                <th style={th}>Source</th>
                <th style={th}>Source ID</th>
                <th style={th}>Tag</th>
                <th style={{ ...th, textAlign: "right" }}>Tangerine</th>
                <th style={{ ...th, textAlign: "right" }}>Xoro</th>
                <th style={{ ...th, textAlign: "right" }}>Variance</th>
                <th style={th}>Status</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {variances.map((v) => (
                <tr key={v.id} data-testid={`recon-variance-row-${v.id}`}>
                  <td style={td}>{v.source_table}</td>
                  <td style={td}>{"—"}</td>
                  <td style={td}>
                    {v.source_tag ? <SourceBadge source={v.source_tag} /> : <span style={{ color: C.textMuted }}>—</span>}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {fmtCents(v.tangerine_amount_cents)}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {fmtCents(v.xoro_amount_cents)}
                  </td>
                  <td
                    style={{
                      ...td, textAlign: "right", fontVariantNumeric: "tabular-nums",
                      color: v.status === "over" ? C.danger : C.text, fontWeight: v.status === "over" ? 600 : 400,
                    }}
                  >
                    {fmtCents(v.variance_amount_cents)}
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        display: "inline-block", padding: "2px 8px", borderRadius: 8,
                        background:
                          v.status === "cleared" ? C.success
                          : v.status === "over" ? C.danger
                          : v.status === "within" ? C.cardBdr
                          : C.warn,
                        color: "white", fontSize: 10, fontWeight: 600,
                      }}
                    >
                      {v.status}
                    </span>
                  </td>
                  <td style={td}>
                    {v.status !== "cleared" && (
                      <button
                        onClick={() => onClear(v)}
                        style={btnDanger}
                        data-testid={`recon-clear-btn-${v.id}`}
                      >
                        Clear…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Clear-reason modal — D3 audit pattern. The reason field is REQUIRED
// (matches the recon_cleared_log.reason NOT NULL constraint).
// ─────────────────────────────────────────────────────────────────────────
function ClearReasonModal({
  variance, onCancel, onConfirm,
}: {
  variance: ReconVariance;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmed = reason.trim();
  const canConfirm = trimmed.length > 0 && !busy;

  async function go() {
    if (!canConfirm) return;
    setBusy(true); setErr(null);
    try {
      await onConfirm(trimmed);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
      data-testid="recon-clear-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(95vw, 520px)", color: C.text }}
      >
        <h3 style={{ margin: "0 0 12px", fontSize: 18 }}>Clear variance with reason</h3>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
          The reason becomes part of the permanent audit trail
          (<code>recon_cleared_log</code>). It is <strong>required</strong>.
        </div>

        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
          <div style={{ color: C.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Variance
          </div>
          <div style={{ fontSize: 11 }}>
            {variance.source_table}
          </div>
          <div style={{ marginTop: 4 }}>
            T: {fmtCents(variance.tangerine_amount_cents)} · X: {fmtCents(variance.xoro_amount_cents)} · Δ: <strong style={{ color: C.danger }}>{fmtCents(variance.variance_amount_cents)}</strong>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Reason <span style={{ color: C.danger }}>*</span>
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Xoro retroactive credit memo CM-99213 not yet mirrored; OK to clear."
            style={textareaStyle}
            disabled={busy}
            data-testid="recon-clear-reason-input"
          />
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }} data-testid="recon-clear-modal-error">
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={btnSecondary} disabled={busy} data-testid="recon-clear-cancel">
            Cancel
          </button>
          <button
            onClick={() => void go()}
            style={{ ...btnDanger, padding: "6px 14px", opacity: canConfirm ? 1 : 0.5, cursor: canConfirm ? "pointer" : "not-allowed" }}
            disabled={!canConfirm}
            data-testid="recon-clear-confirm"
          >
            {busy ? "Clearing…" : "Clear variance"}
          </button>
        </div>
      </div>
    </div>
  );
}
