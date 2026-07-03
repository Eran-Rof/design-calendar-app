// src/tanda/InternalShadowMirrorStatus.tsx
//
// Cross-cutter T10-7 — Shadow Mirror Status panel.
//
// Single-panel dashboard for the nightly Xoro → Tangerine shadow mirror
// (T10-1..6). Three sections:
//
//   1. Last successful run per domain (AR / AP / Inventory / Summary JE)
//      — 4 cards across the top showing the most recent xoro_mirror_runs
//      row with status='complete' per domain.
//
//   2. Last 30 days history grid — date column + 4 status badges per
//      day (green=complete, yellow=skipped, red=failed, gray=no run).
//      Click any cell → modal with the full run details.
//
//   3. Action bar — Manual re-run (admin), Unmatched customers / vendors
//      count badges with modal drill-in, and a manual-fallback reminder
//      card.
//
// Reads: GET /api/internal/xoro-mirror-runs (recent rows).
// Triggers: POST /api/cron/xoro-mirror-nightly?mirror_date=YYYY-MM-DD.
//
// Per arch §6 — operator wants a heartbeat that the mirror ran + a quick
// way to drill into per-domain status without leaving the panel.

import { useEffect, useMemo, useState } from "react";
import { confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";

// ─────────────────────────────────────────────────────────────────────────
// Theme — match the Bank Reconciliation panel palette.
// ─────────────────────────────────────────────────────────────────────────
const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  tangerine: "#fb923c",
};

// Domain badge colors — tracked here so callers (history grid cells) all
// pick from the same palette.
const STATUS_COLOR: Record<string, string> = {
  complete:            C.success,
  skipped_no_change:   C.warn,
  skipped_stale_xoro:  C.warn,
  failed:              C.danger,
  running:             C.primary,
};

const DOMAINS = ["ar", "ap", "inventory", "summary_je"] as const;
type Domain = (typeof DOMAINS)[number];

const DOMAIN_LABEL: Record<Domain, string> = {
  ar:         "AR",
  ap:         "AP",
  inventory:  "Inventory",
  summary_je: "Summary JE",
};

type MirrorRun = {
  id: string;
  entity_id: string;
  domain: Domain;
  mirror_date: string;
  rows_upserted: number;
  rows_deleted: number;
  rows_unchanged: number;
  je_id: string | null;
  errors: unknown[];
  started_at: string;
  completed_at: string | null;
  status: "running" | "complete" | "failed" | "skipped_no_change" | "skipped_stale_xoro";
};

type BackfillJob = {
  id: string;
  from_date: string;
  to_date: string;
  cursor_date: string;
  status: "pending" | "running" | "complete" | "failed" | "cancelled";
  days_total: number;
  days_done: number;
  totals?: { ar_upserted?: number; ap_upserted?: number; inventory_upserted?: number; summary_jes_posted?: number };
  je_count?: number;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12,
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 12,
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function todayMinusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Backfill auto-chunking. The /backfill-range endpoint caps one call at
// MAX_RANGE_DAYS (server-side) to stay under the function time limit, so a larger
// range is split here into consecutive windows and run one after another. Keep in
// sync with MAX_RANGE_DAYS in api/cron/xoro-mirror-nightly.js.
const RANGE_CHUNK_DAYS = 45;
function isoAddDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}
// Split [from, to] (inclusive) into consecutive [start, end] windows of ≤ size days.
function chunkDateRange(from: string, to: string, size: number): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  let start = from;
  while (start <= to) {
    const end = isoAddDays(start, size - 1) > to ? to : isoAddDays(start, size - 1);
    chunks.push([start, end]);
    start = isoAddDays(end, 1);
  }
  return chunks;
}

// Group the last-30-days runs into a Date → Domain → MirrorRun lookup.
function indexByDate(rows: MirrorRun[]): Record<string, Partial<Record<Domain, MirrorRun>>> {
  const out: Record<string, Partial<Record<Domain, MirrorRun>>> = {};
  for (const r of rows) {
    if (!out[r.mirror_date]) out[r.mirror_date] = {};
    // If multiple runs for same (date, domain), keep the most recent by
    // started_at (cron idempotency means there should only be one with a
    // terminal status, but a failed-then-complete re-run can leave two).
    const existing = out[r.mirror_date][r.domain];
    if (!existing || r.started_at > existing.started_at) {
      out[r.mirror_date][r.domain] = r;
    }
  }
  return out;
}

// Build a descending date list spanning the last 30 days.
function last30Dates(): string[] {
  const dates: string[] = [];
  for (let i = 0; i < 30; i++) dates.push(todayMinusDays(i));
  return dates;
}

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────
export default function InternalShadowMirrorStatus() {
  const [runs, setRuns] = useState<MirrorRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [detailRun, setDetailRun] = useState<MirrorRun | null>(null);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [unmatchedKind, setUnmatchedKind] = useState<"customers" | "vendors" | null>(null);
  const [backfillJobs, setBackfillJobs] = useState<BackfillJob[]>([]);

  // Background backfill jobs — polled while any is active so progress advances
  // live without a manual refresh.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const r = await fetch("/api/internal/xoro-mirror/backfill-job?limit=8");
        if (r.ok) {
          const rows = await r.json();
          if (!stop) setBackfillJobs(Array.isArray(rows) ? rows as BackfillJob[] : []);
          const active = Array.isArray(rows) && rows.some((j: BackfillJob) => j.status === "pending" || j.status === "running");
          if (!stop) timer = setTimeout(poll, active ? 5000 : 30000);
          return;
        }
      } catch { /* ignore */ }
      if (!stop) timer = setTimeout(poll, 30000);
    }
    void poll();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, []);

  const authUserId = getCachedAuthUserId();
  // Admin guard: if there's no cached uuid the operator hasn't completed
  // the MS sign-in bridge yet. Treat as non-admin for the re-run button.
  const isAdmin = !!authUserId;

  async function load() {
    setLoading(true); setErr(null);
    try {
      // T10-1 ships GET /api/internal/xoro-mirror-runs (list by recency).
      // If the handler isn't deployed yet (T10-6 may still be rolling), we
      // get a 404 — surface the error inline but don't crash.
      const r = await fetch("/api/internal/xoro-mirror-runs?limit=500");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const arr = await r.json();
      setRuns(Array.isArray(arr) ? (arr as MirrorRun[]) : []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  // Latest complete run per domain (for the 4 top cards).
  const latestComplete = useMemo<Partial<Record<Domain, MirrorRun>>>(() => {
    const out: Partial<Record<Domain, MirrorRun>> = {};
    for (const r of runs) {
      if (r.status !== "complete") continue;
      const existing = out[r.domain];
      if (!existing || r.mirror_date > existing.mirror_date) {
        out[r.domain] = r;
      }
    }
    return out;
  }, [runs]);

  // 30-day history grid index.
  const byDate = useMemo(() => indexByDate(runs), [runs]);
  const dates = useMemo(() => last30Dates(), []);

  // Unmatched-customer / unmatched-vendor error extraction. Per arch §6,
  // v1 has no dedicated log table — we surface errors from xoro_mirror_runs
  // whose error message contains "customer" / "unmatched_customer" (and
  // similarly for vendors).
  const unmatched = useMemo(() => {
    const customers: Array<{ run: MirrorRun; error: string }> = [];
    const vendors: Array<{ run: MirrorRun; error: string }> = [];
    for (const r of runs) {
      if (!Array.isArray(r.errors)) continue;
      for (const e of r.errors) {
        const msg = typeof e === "string" ? e : (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : JSON.stringify(e));
        const low = msg.toLowerCase();
        if (low.includes("unmatched_customer") || (low.includes("customer") && low.includes("not found"))) {
          customers.push({ run: r, error: msg });
        }
        if (low.includes("unmatched_vendor") || (low.includes("vendor") && low.includes("not found"))) {
          vendors.push({ run: r, error: msg });
        }
      }
    }
    return { customers, vendors };
  }, [runs]);

  // Build the export rows for the 30-day grid: one row per date with the
  // four domain statuses pivoted into columns.
  const exportRows = useMemo(
    () => dates.map((d) => {
      const cells = byDate[d] || {};
      return {
        mirror_date: d,
        ar_status:         cells.ar?.status ?? "—",
        ar_rows:           cells.ar?.rows_upserted ?? null,
        ap_status:         cells.ap?.status ?? "—",
        ap_rows:           cells.ap?.rows_upserted ?? null,
        inventory_status:  cells.inventory?.status ?? "—",
        inventory_rows:    cells.inventory?.rows_upserted ?? null,
        summary_je_status: cells.summary_je?.status ?? "—",
        summary_je_id:     cells.summary_je?.je_id ?? null,
      };
    }),
    [dates, byDate],
  );

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Shadow Mirror Status</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>
            Nightly Xoro → Tangerine mirror · cadence 21:30 local
          </span>
          <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        </div>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          Error: {err}
        </div>
      )}

      {/* ───── Top section: last successful run per domain (4 cards) ───── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {DOMAINS.map((d) => {
          const run = latestComplete[d];
          return (
            <div
              key={d}
              style={{
                background: C.card,
                border: `1px solid ${C.cardBdr}`,
                borderRadius: 10,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                cursor: run ? "pointer" : "default",
              }}
              onClick={() => run && setDetailRun(run)}
              title={run ? "Click for run details" : "No successful run yet"}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{DOMAIN_LABEL[d]}</span>
              </div>
              {run ? (
                <>
                  <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Last complete
                  </div>
                  <div style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{run.mirror_date}</div>
                  {d !== "summary_je" ? (
                    <div style={{ fontSize: 11, color: C.textSub }}>
                      <strong style={{ color: C.text }}>{run.rows_upserted.toLocaleString()}</strong> upserted
                      {run.rows_unchanged > 0 ? <> · <span style={{ color: C.textMuted }}>{run.rows_unchanged.toLocaleString()} unchanged</span></> : null}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: C.textSub }}>
                      JE: <span style={{ color: run.je_id ? C.success : C.textMuted }}>
                        {run.je_id ? "✓ posted" : "—"}
                      </span>
                    </div>
                  )}
                  {Array.isArray(run.errors) && run.errors.length > 0 && (
                    <div style={{ fontSize: 10, color: C.warn }}>
                      {run.errors.length} conflict{run.errors.length === 1 ? "" : "s"}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 12, color: C.textMuted, fontStyle: "italic" }}>
                  {loading ? "Loading…" : "No successful run yet"}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ───── Middle section: last 30 days history grid ───── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
          Last 30 days
        </h3>
        <ExportButton
          rows={exportRows as unknown as Array<Record<string, unknown>>}
          filename="shadow-mirror-history"
          sheetName="Shadow Mirror History"
          columns={[
            { key: "mirror_date",        header: "Date",            format: "date" },
            { key: "ar_status",          header: "AR Status" },
            { key: "ar_rows",            header: "AR Rows",         format: "number" },
            { key: "ap_status",          header: "AP Status" },
            { key: "ap_rows",            header: "AP Rows",         format: "number" },
            { key: "inventory_status",   header: "Inventory Status" },
            { key: "inventory_rows",     header: "Inventory Rows",  format: "number" },
            { key: "summary_je_status",  header: "Summary JE Status" },
            { key: "summary_je_id",      header: "Summary JE ID" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
        {loading ? (
          <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>Loading…</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 120 }}>Date</th>
                {DOMAINS.map((d) => (
                  <th key={d} style={{ ...th, textAlign: "center" }}>{DOMAIN_LABEL[d]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((date) => {
                const cells = byDate[date] || {};
                return (
                  <tr key={date}>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{date}</td>
                    {DOMAINS.map((d) => {
                      const run = cells[d];
                      const color = run ? (STATUS_COLOR[run.status] || C.textMuted) : "#475569";
                      const label = run ? run.status : "—";
                      return (
                        <td
                          key={d}
                          style={{ ...td, textAlign: "center", cursor: run ? "pointer" : "default" }}
                          onClick={() => run && setDetailRun(run)}
                          title={run ? `${run.status} · click for details` : "No run for this domain that day"}
                        >
                          <span
                            style={{
                              display: "inline-block",
                              minWidth: 80,
                              padding: "2px 8px",
                              borderRadius: 12,
                              background: run ? color : "transparent",
                              color: run ? "white" : C.textMuted,
                              border: run ? "none" : `1px dashed ${C.cardBdr}`,
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            {label}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ───── Bottom action bar ───── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 18 }}>
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            Manual actions
          </div>
          <button
            onClick={() => setRerunOpen(true)}
            disabled={!isAdmin}
            style={{ ...btnPrimary, opacity: isAdmin ? 1 : 0.5, cursor: isAdmin ? "pointer" : "not-allowed" }}
            title={isAdmin ? "Trigger the mirror cron for a chosen date" : "Sign-in required (admin only)"}
          >
            Re-run mirror…
          </button>
          {!isAdmin && (
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 6 }}>
              Sign in via MS to enable manual re-run.
            </div>
          )}
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Unmatched queue
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setUnmatchedKind("customers")} style={btnSecondary}>
              Customers
              <span style={{
                marginLeft: 6, background: unmatched.customers.length > 0 ? C.warn : C.cardBdr,
                color: unmatched.customers.length > 0 ? "#1f1300" : C.textMuted,
                padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 700,
              }}>
                {unmatched.customers.length}
              </span>
            </button>
            <button onClick={() => setUnmatchedKind("vendors")} style={btnSecondary}>
              Vendors
              <span style={{
                marginLeft: 6, background: unmatched.vendors.length > 0 ? C.warn : C.cardBdr,
                color: unmatched.vendors.length > 0 ? "#1f1300" : C.textMuted,
                padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 700,
              }}>
                {unmatched.vendors.length}
              </span>
            </button>
          </div>
          <div style={{ fontSize: 10, color: C.textMuted, lineHeight: 1.4 }}>
            Rows the Xoro feed references but Tangerine's master data lacks. Add the master record then re-run the mirror for that date.
          </div>
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.tangerine}55`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: C.tangerine, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Manual fallback
          </div>
          <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.5 }}>
            Need to enter an invoice for an event Xoro didn't capture? Use the <strong>AR Invoices</strong> / <strong>AP Invoices</strong> panel directly. Your manual entry uses <code>source='manual'</code> and the mirror will never overwrite it.
          </div>
        </div>
      </div>

      {/* Background backfills — unattended range jobs drained by the worker cron. */}
      {backfillJobs.length > 0 && (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 14, marginTop: 16 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            Background backfills
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {backfillJobs.map((j) => {
              const pct = j.days_total > 0 ? Math.min(100, Math.round((j.days_done / j.days_total) * 100)) : 0;
              const color = j.status === "complete" ? C.success : j.status === "failed" ? C.danger : j.status === "running" ? C.primary : C.warn;
              return (
                <div key={j.id} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontSize: 13 }}>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{j.from_date} → {j.to_date}</span>
                    <span style={{ color, fontSize: 12, fontWeight: 600 }}>● {j.status}{j.status === "running" || j.status === "pending" ? ` · next ${j.cursor_date}` : ""}</span>
                  </div>
                  <div style={{ height: 6, background: "#0b1220", borderRadius: 4, overflow: "hidden", margin: "6px 0" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: color }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.textMuted }}>
                    <span>{j.days_done}/{j.days_total} day(s) · {j.totals?.summary_jes_posted ?? j.je_count ?? 0} JE(s)</span>
                    <span>AR {j.totals?.ar_upserted ?? 0} · AP {j.totals?.ap_upserted ?? 0} · INV {j.totals?.inventory_upserted ?? 0}</span>
                  </div>
                  {j.status === "failed" && j.last_error && (
                    <div style={{ marginTop: 4, fontSize: 11, color: C.danger }}>{j.last_error}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {detailRun && (
        <RunDetailModal run={detailRun} onClose={() => setDetailRun(null)} />
      )}
      {rerunOpen && (
        <ReRunModal onClose={() => setRerunOpen(false)} onDone={() => { setRerunOpen(false); void load(); }} />
      )}
      {unmatchedKind && (
        <UnmatchedModal
          kind={unmatchedKind}
          rows={unmatchedKind === "customers" ? unmatched.customers : unmatched.vendors}
          onClose={() => setUnmatchedKind(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Run-detail modal — clicked from a top card or a grid cell.
// ─────────────────────────────────────────────────────────────────────────
function RunDetailModal({ run, onClose }: { run: MirrorRun; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(95vw, 640px)", maxHeight: "85vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 18 }}>
          {DOMAIN_LABEL[run.domain]} mirror — {run.mirror_date}
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", fontSize: 12, marginBottom: 16 }}>
          <span style={{ color: C.textMuted }}>Status</span>
          <span style={{ color: STATUS_COLOR[run.status] || C.text, fontWeight: 600 }}>● {run.status}</span>
          <span style={{ color: C.textMuted }}>Started</span>
          <span>{fmtDateTime(run.started_at)}</span>
          <span style={{ color: C.textMuted }}>Completed</span>
          <span>{fmtDateTime(run.completed_at)}</span>
          <span style={{ color: C.textMuted }}>Upserted</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{run.rows_upserted.toLocaleString()}</span>
          <span style={{ color: C.textMuted }}>Unchanged</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{run.rows_unchanged.toLocaleString()}</span>
          <span style={{ color: C.textMuted }}>Deleted</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{run.rows_deleted.toLocaleString()}</span>
          {run.je_id && (
            <>
              <span style={{ color: C.textMuted }}>Summary JE</span>
              <span style={{ color: C.success, fontSize: 11 }}>✓ posted</span>
            </>
          )}
          <span style={{ color: C.textMuted }}>Run date</span>
          <span style={{ fontSize: 11 }}>{run.mirror_date}</span>
        </div>

        {Array.isArray(run.errors) && run.errors.length > 0 ? (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.warn, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
              Errors ({run.errors.length})
            </div>
            <pre style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, fontSize: 11, maxHeight: 240, overflow: "auto", color: C.textSub, margin: 0 }}>
              {JSON.stringify(run.errors, null, 2)}
            </pre>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.success, marginBottom: 16 }}>✓ No errors recorded.</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Re-run modal — admin-only. Pick a date, POST to the cron handler with
// a manual_trigger=true override so it ignores the idempotency skip.
// ─────────────────────────────────────────────────────────────────────────
function ReRunModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"single" | "range">("single");
  const [mirrorDate, setMirrorDate] = useState(todayMinusDays(1));
  const [fromDate, setFromDate] = useState(todayMinusDays(7));
  const [toDate, setToDate] = useState(todayMinusDays(1));
  const [background, setBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (mode === "range") { await (background ? runBackground() : runRange()); return; }
    if (!(await confirmDialog(`Re-run the Xoro mirror for ${mirrorDate}? This will overwrite source='xoro_mirror' rows for that date. Manual entries stay untouched.`))) return;
    setBusy(true); setErr(null); setResult("Running… (this can take a few minutes)");
    try {
      const r = await fetch(`/api/cron/xoro-mirror-nightly?mirror_date=${encodeURIComponent(mirrorDate)}&manual_trigger=true`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(data.error || `HTTP ${r.status}`); setResult(null); return; }
      const parts: string[] = [];
      if (data.ar)         parts.push(`AR: ${data.ar.status || "?"} (${data.ar.rows_upserted ?? 0})`);
      if (data.ap)         parts.push(`AP: ${data.ap.status || "?"} (${data.ap.rows_upserted ?? 0})`);
      if (data.inventory)  parts.push(`INV: ${data.inventory.status || "?"} (${data.inventory.rows_upserted ?? 0})`);
      if (data.summary_je) parts.push(`JE: ${data.summary_je.status || "?"}`);
      setResult(parts.length > 0 ? parts.join(" · ") : "Mirror complete.");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  // One-shot backfill of a whole date range — of ANY length. Each date mirrors +
  // posts its own summary JEs into its own period; the reversal-safe, idempotent
  // per-date pipeline is reused. Ranges longer than the endpoint's per-call cap
  // are AUTO-CHUNKED here into consecutive windows run one after another, so the
  // operator picks any span and it just works. Overwrites only source='xoro_mirror'.
  async function runRange() {
    if (fromDate > toDate) { setErr("From date must be on or before To date."); return; }
    const chunks = chunkDateRange(fromDate, toDate, RANGE_CHUNK_DAYS);
    if (!(await confirmDialog(
      `Re-run the Xoro mirror for every date from ${fromDate} to ${toDate}` +
      (chunks.length > 1 ? ` (auto-split into ${chunks.length} chunks of up to ${RANGE_CHUNK_DAYS} days)` : "") +
      `? Each date is mirrored and its summary JEs post into that date's period. Only source='xoro_mirror' rows are overwritten; manual entries stay untouched.`,
    ))) return;
    setBusy(true); setErr(null);
    const agg = { days: 0, ar: 0, ap: 0, inv: 0, je: 0, errors: 0 };
    let anyPartial = false;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const [cf, ct] = chunks[i];
        setResult(
          `Running${chunks.length > 1 ? ` chunk ${i + 1}/${chunks.length}` : ""} (${cf}→${ct})… don't close.` +
          (i > 0 ? `  So far: ${agg.days} day(s), ${agg.je} JE(s).` : ""),
        );
        const r = await fetch("/api/internal/xoro-mirror/backfill-range", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: cf, to: ct }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          // Stop on a hard failure rather than hammer the backend for every
          // remaining chunk; report what already completed.
          setErr(`Chunk ${cf}→${ct} failed: ${data.error || `HTTP ${r.status}`}. Completed ${agg.days} day(s) before this.`);
          setResult(null);
          return;
        }
        const t = data.totals || {};
        agg.days += data.days || 0;
        agg.ar += t.ar_upserted || 0;
        agg.ap += t.ap_upserted || 0;
        agg.inv += t.inventory_upserted || 0;
        agg.je += t.summary_jes_posted || 0;
        agg.errors += Array.isArray(data.errors) ? data.errors.length : 0;
        if (data.status !== "complete") anyPartial = true;
      }
      setResult(
        `${anyPartial || agg.errors ? "⚠" : "✓"} ${agg.days} day(s) ${fromDate}→${toDate}` +
        (chunks.length > 1 ? ` in ${chunks.length} chunks` : "") +
        ` — AR ${agg.ar} · AP ${agg.ap} · INV ${agg.inv} · ${agg.je} JE(s)` +
        (agg.errors ? ` · ${agg.errors} error(s)` : ""),
      );
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  // Unattended backfill: enqueue a job and let the worker cron drain it. The
  // operator can close the tab; progress shows in the Background backfills list.
  async function runBackground() {
    if (fromDate > toDate) { setErr("From date must be on or before To date."); return; }
    if (!(await confirmDialog(`Queue a background backfill for ${fromDate} → ${toDate}? It runs on the server in chunks — you can close this tab and watch progress in "Background backfills". Only source='xoro_mirror' rows are overwritten.`))) return;
    setBusy(true); setErr(null); setResult("Queuing…");
    try {
      const r = await fetch("/api/internal/xoro-mirror/backfill-job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromDate, to: toDate }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(data.error || `HTTP ${r.status}`); setResult(null); return; }
      setResult(`✓ Queued ${data.days_total ?? "?"} day(s) ${fromDate}→${toDate}. It runs in the background — safe to close. Track it under "Background backfills".`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(95vw, 480px)", color: C.text }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 18 }}>Re-run shadow mirror</h3>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16, lineHeight: 1.5 }}>
          Re-processes the Xoro mirror for a single business date or a whole date range in one shot. Each date mirrors AR/AP/inventory and posts its summary JEs into that date&apos;s own period. Operator-typed (manual) rows are never touched; only xoro_mirror rows get rewritten.
        </div>

        {/* Single date vs date range */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {(["single", "range"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} disabled={busy}
              style={{ ...(mode === m ? btnPrimary : btnSecondary), flex: 1, textTransform: "capitalize" }}>
              {m === "single" ? "Single date" : "Date range"}
            </button>
          ))}
        </div>

        {mode === "single" ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>Mirror date</div>
            <input
              type="date"
              value={mirrorDate}
              onChange={(e) => setMirrorDate(e.target.value)}
              disabled={busy}
              style={{ ...inputStyle, width: "100%" }}
              max={todayMinusDays(0)}
            />
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>From</div>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} disabled={busy} style={{ ...inputStyle, width: "100%" }} max={todayMinusDays(0)} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>To</div>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} disabled={busy} style={{ ...inputStyle, width: "100%" }} max={todayMinusDays(0)} />
            </div>
          </div>
        )}

        {mode === "range" && (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 12, fontSize: 12, color: C.textSub, cursor: "pointer" }}>
            <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} disabled={busy} style={{ marginTop: 2 }} />
            <span><b>Run in background</b> — queue it on the server and <b>close the tab</b>. A worker drains it in chunks; track progress under &quot;Background backfills&quot;. Best for long ranges.</span>
          </label>
        )}

        {result && (
          <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, padding: "8px 10px", borderRadius: 6, fontSize: 12, marginBottom: 12, color: busy ? C.textSub : C.success }}>
            {result}
          </div>
        )}
        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary} disabled={busy}>{result && !busy ? "Done" : "Cancel"}</button>
          <button onClick={() => void run()} style={btnPrimary}
            disabled={busy || (mode === "single" ? !mirrorDate : (!fromDate || !toDate))}>
            {busy ? (background && mode === "range" ? "Queuing…" : "Running…") : (mode === "single" ? "Re-run mirror" : (background ? "Queue backfill" : "Run range"))}
          </button>
          {result && !busy && (
            <button onClick={onDone} style={btnPrimary}>Refresh & close</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Unmatched-customers / vendors modal — v1 reads from the runs' `errors`
// array (no dedicated log table yet, per arch §6).
// ─────────────────────────────────────────────────────────────────────────
function UnmatchedModal({
  kind, rows, onClose,
}: {
  kind: "customers" | "vendors";
  rows: Array<{ run: MirrorRun; error: string }>;
  onClose: () => void;
}) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(95vw, 720px)", maxHeight: "85vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>
          Unmatched {kind} ({rows.length})
        </h3>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          Surfaced from mirror-run error messages. To clear: add the {kind === "customers" ? "customer" : "vendor"} to Master Data, then re-run the mirror for the listed date.
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 20, color: C.success, textAlign: "center", fontSize: 13 }}>
            ✓ No unmatched {kind} in the recent mirror history.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Domain</th>
                <th style={th}>Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.run.id}-${i}`}>
                  <td style={td}>{r.run.mirror_date}</td>
                  <td style={td}>{DOMAIN_LABEL[r.run.domain]}</td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>{r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>
  );
}
