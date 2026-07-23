// src/tanda/InternalBetaData.tsx
//
// Beta guardrails — Chunk C: the Beta Data admin screen (🧪 Admin nav group).
//
// Three sections over the beta_config window + beta_created_docs registry:
//   1. Beta window card — active/inactive status, started/ended stamps,
//      Start/End with a confirm modal (frozen footer) and the PITR reminder.
//   2. Summary — per-table registry counts (total / cleaned / outstanding).
//   3. Outstanding rows — the tagged docs still live, each with a DRY-RUN
//      eligibility verdict from the cleanup engine; select rows and run a
//      reviewed cleanup (confirm modal lists what will delete vs refuse).
//
// Reads/writes the chunk-C handler:
//   GET  /api/internal/beta-data                   → { config, summary, rows }
//   POST /api/internal/beta-data { action: "start_window" | "end_window" | "cleanup" }
//
// Posted documents always REFUSE here — they are reversed through the normal
// posting flow (T11 reason), never deleted. ZZ-BETA masters are kept.

import { useCallback, useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

type BetaConfig = {
  id: string;
  active: boolean;
  started_at: string | null;
  ended_at: string | null;
  started_by_user_id: string | null;
  notes: string | null;
};
type SummaryRow = { table_name: string; total: number; cleaned: number; outstanding: number };
type Eligibility = { verdict: "deletable" | "refused" | "already_gone"; reason?: string };
type RegistryRow = {
  id: number;
  table_name: string;
  doc_label: string | null;
  source: string | null;
  created_by_email: string | null;
  created_at: string;
  eligibility: Eligibility;
};
type Payload = { config: BetaConfig | null; summary: SummaryRow[]; rows: RegistryRow[]; warning?: string };
type CleanupResult = { id: number | string; table_name?: string; outcome: string; reason?: string };

const C = {
  bg: "#0b1220", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", danger: "#EF4444", warn: "#F59E0B",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnDanger: React.CSSProperties = { ...btnPrimary, background: C.danger };
const btnGhost: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13,
};

// MM/DD/YYYY + time (app-wide US date convention).
function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()} ${hh}:${mi}`;
}
function fmtDate(iso: string | null | undefined): string {
  const t = fmtTs(iso);
  return t === "—" ? t : t.slice(0, 10);
}

// Registry rows display doc_label; when absent, table + created date (never a
// raw UUID).
function labelOf(r: RegistryRow): string {
  return r.doc_label?.trim() || `${r.table_name} · ${fmtDate(r.created_at)}`;
}

function VerdictBadge({ e }: { e: Eligibility }) {
  const map: Record<string, { bg: string; label: string }> = {
    deletable: { bg: C.success, label: "deletable" },
    refused: { bg: C.warn, label: e.reason || "refused" },
    already_gone: { bg: "#64748B", label: "already gone" },
  };
  const v = map[e.verdict] || { bg: C.danger, label: e.verdict };
  return (
    <span title={e.reason || v.label} style={{
      background: v.bg, color: "#0b1220", borderRadius: 4, padding: "2px 8px",
      fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
    }}>
      {v.label}
    </span>
  );
}

// Confirm modal with a frozen footer button row (content scrolls, footer stays).
function ConfirmModal({ title, children, confirmLabel, confirmStyle, busy, onConfirm, onCancel }: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  confirmStyle?: React.CSSProperties;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(2,6,23,0.7)", zIndex: 60,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        width: "min(640px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 15, fontWeight: 700, color: C.text }}>
          {title}
        </div>
        <div style={{ padding: 18, overflowY: "auto", color: C.textSub, fontSize: 13, lineHeight: 1.55 }}>
          {children}
        </div>
        <div style={{
          padding: "12px 18px", borderTop: `1px solid ${C.cardBdr}`,
          display: "flex", justifyContent: "flex-end", gap: 10, flexShrink: 0,
        }}>
          <button style={btnGhost} onClick={onCancel} disabled={busy}>Cancel</button>
          <button style={{ ...(confirmStyle || btnPrimary), opacity: busy ? 0.6 : 1 }} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function InternalBetaData() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [modal, setModal] = useState<null | "start" | "end" | "cleanup">(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [outcomes, setOutcomes] = useState<CleanupResult[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/beta-data");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const p: Payload = await r.json();
      setData(p);
      setSelected(new Set());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const cfg = data?.config || null;
  const rows = useMemo(() => data?.rows || [], [data]);
  const selRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selDeletable = useMemo(() => selRows.filter((r) => r.eligibility.verdict !== "refused"), [selRows]);
  const selRefused = useMemo(() => selRows.filter((r) => r.eligibility.verdict === "refused"), [selRows]);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch("/api/internal/beta-data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
    return j as Record<string, unknown>;
  }

  async function runWindowToggle(action: "start_window" | "end_window") {
    setBusy(true);
    setErr(null);
    try {
      await post(action === "start_window" ? { action, notes: notes || undefined } : { action });
      setModal(null);
      setNotes("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
      setModal(null);
    } finally {
      setBusy(false);
    }
  }

  async function runCleanup() {
    setBusy(true);
    setErr(null);
    try {
      const j = await post({ action: "cleanup", ids: selRows.map((r) => r.id), confirm: true });
      setOutcomes((j.results as CleanupResult[]) || []);
      setModal(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
      setModal(null);
    } finally {
      setBusy(false);
    }
  }

  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)));
  }

  const exportRows = useMemo(
    () => rows.map((r) => ({
      doc: labelOf(r),
      table: r.table_name,
      source: r.source || "",
      created_by: r.created_by_email || "",
      created: fmtTs(r.created_at),
      verdict: r.eligibility.verdict,
      reason: r.eligibility.reason || "",
    })),
    [rows],
  );

  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(String(r.id), labelOf(r));
    return m;
  }, [rows]);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Beta Data</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Beta window control, tagged-document registry, and reviewed cleanup.
        </span>
        <div style={{ marginLeft: "auto" }}>
          <ExportButton
            rows={exportRows as unknown as Array<Record<string, unknown>>}
            filename="beta-data-outstanding"
            sheetName="Beta Data"
            columns={[
              { key: "doc",        header: "Document" },
              { key: "table",      header: "Table" },
              { key: "source",     header: "Source" },
              { key: "created_by", header: "Created By" },
              { key: "created",    header: "Created" },
              { key: "verdict",    header: "Verdict" },
              { key: "reason",     header: "Reason" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      {data?.warning && (
        <div style={{ background: "#78350f", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{data.warning}</div>
      )}
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}

      {!loading && data && (
        <>
          {/* ── 1. Beta window card ─────────────────────────────────────── */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Beta window</div>
              <span style={{
                background: cfg?.active ? C.success : "#64748B", color: "#0b1220",
                borderRadius: 4, padding: "2px 10px", fontSize: 12, fontWeight: 700,
              }}>
                {cfg?.active ? "ACTIVE" : "INACTIVE"}
              </span>
              <span style={{ color: C.textSub, fontSize: 13 }}>
                Started: <strong>{fmtTs(cfg?.started_at)}</strong>
              </span>
              <span style={{ color: C.textSub, fontSize: 13 }}>
                Ended: <strong>{fmtTs(cfg?.ended_at)}</strong>
              </span>
              <div style={{ marginLeft: "auto" }}>
                {cfg?.active ? (
                  <button style={btnDanger} onClick={() => setModal("end")}>End beta window</button>
                ) : (
                  <button style={btnPrimary} onClick={() => setModal("start")} disabled={!data.config && !!data.warning}>
                    Start beta window
                  </button>
                )}
              </div>
            </div>
            {cfg?.notes && (
              <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>Notes: {cfg.notes}</div>
            )}
            <div style={{ color: C.warn, fontSize: 12, marginTop: 10 }}>
              Record a PITR restore point before starting — see BETA-RUNBOOK. While the window is active, every
              document and master created anywhere in the suite is tagged into this registry.
            </div>
          </div>

          {/* ── 2. Summary per table ────────────────────────────────────── */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 16, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", fontSize: 14, fontWeight: 700, borderBottom: `1px solid ${C.cardBdr}` }}>
              Registry summary
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Table</th>
                    <th style={{ ...th, textAlign: "right" }}>Total tagged</th>
                    <th style={{ ...th, textAlign: "right" }}>Cleaned</th>
                    <th style={{ ...th, textAlign: "right" }}>Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.summary || []).length === 0 && (
                    <tr><td style={{ ...td, color: C.textMuted }} colSpan={4}>Nothing tagged yet.</td></tr>
                  )}
                  {(data.summary || []).map((s) => (
                    <tr key={s.table_name}>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{s.table_name}</td>
                      <td style={{ ...td, textAlign: "right" }}>{s.total}</td>
                      <td style={{ ...td, textAlign: "right", color: C.success }}>{s.cleaned}</td>
                      <td style={{ ...td, textAlign: "right", color: s.outstanding > 0 ? C.warn : C.textMuted }}>{s.outstanding}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Cleanup outcomes (after a run) ──────────────────────────── */}
          {outcomes && (
            <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 16, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", fontSize: 14, fontWeight: 700, borderBottom: `1px solid ${C.cardBdr}`, display: "flex", alignItems: "center" }}>
                Cleanup outcomes
                <button style={{ ...btnGhost, marginLeft: "auto", padding: "4px 10px" }} onClick={() => setOutcomes(null)}>✕ Dismiss</button>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr><th style={th}>Document</th><th style={th}>Outcome</th><th style={th}>Detail</th></tr>
                  </thead>
                  <tbody>
                    {outcomes.map((o, i) => (
                      <tr key={i}>
                        <td style={td}>{labelById.get(String(o.id)) || o.table_name || `registry #${o.id}`}</td>
                        <td style={{ ...td, color: o.outcome === "deleted" ? C.success : o.outcome === "refused" ? C.warn : C.textSub, fontWeight: 600 }}>
                          {o.outcome}
                        </td>
                        <td style={{ ...td, color: C.textMuted }}>{o.reason || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── 3. Outstanding tagged rows ──────────────────────────────── */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.cardBdr}`, flexWrap: "wrap" }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Outstanding tagged documents ({rows.length})</div>
              <span style={{ color: C.textMuted, fontSize: 12 }}>
                Verdicts are a live dry run — posted documents always refuse (reverse them instead).
              </span>
              <button
                style={{ ...btnDanger, marginLeft: "auto", opacity: selRows.length === 0 ? 0.5 : 1 }}
                disabled={selRows.length === 0}
                onClick={() => setModal("cleanup")}
              >
                Clean up selected ({selRows.length})
              </button>
            </div>
            <div style={{ overflowX: "auto", maxHeight: "60vh", overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 34 }}>
                      <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} style={{ cursor: "pointer" }} />
                    </th>
                    <th style={th}>Document</th>
                    <th style={th}>Table</th>
                    <th style={th}>Source</th>
                    <th style={th}>Created By</th>
                    <th style={th}>Created</th>
                    <th style={th}>Eligibility</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td style={{ ...td, color: C.textMuted }} colSpan={7}>No outstanding tagged documents.</td></tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => toggleRow(r.id)} style={{ cursor: "pointer", background: selected.has(r.id) ? "#16233c" : "transparent" }}>
                      <td style={td} onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} style={{ cursor: "pointer" }} />
                      </td>
                      <td style={{ ...td, color: C.primary, fontWeight: 600 }}>{labelOf(r)}</td>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{r.table_name}</td>
                      <td style={{ ...td, color: C.textMuted }}>{r.source || "—"}</td>
                      <td style={{ ...td, color: C.textSub }}>{r.created_by_email || "—"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTs(r.created_at)}</td>
                      <td style={td}><VerdictBadge e={r.eligibility} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Confirm modals ────────────────────────────────────────────────── */}
      {modal === "start" && (
        <ConfirmModal
          title="Start beta window"
          confirmLabel="Start window"
          busy={busy}
          onConfirm={() => void runWindowToggle("start_window")}
          onCancel={() => setModal(null)}
        >
          <p style={{ marginTop: 0 }}>
            Starting the beta window turns on tagging: every document or master created anywhere in the suite
            will be recorded in this registry until the window is ended.
          </p>
          <p style={{ color: C.warn }}>
            Before confirming: record a PITR restore point (Supabase dashboard) and note the start time — see
            docs/tangerine/BETA-RUNBOOK.md.
          </p>
          <label style={{ display: "block", fontSize: 12, color: C.textMuted, marginBottom: 4 }}>Notes (optional)</label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. beta cohort 1 — AR + SO flows"
            style={{
              width: "100%", boxSizing: "border-box", background: "#0b1220", color: C.text,
              border: `1px solid ${C.cardBdr}`, padding: "8px 10px", borderRadius: 4, fontSize: 13, colorScheme: "dark",
            }}
          />
        </ConfirmModal>
      )}

      {modal === "end" && (
        <ConfirmModal
          title="End beta window"
          confirmLabel="End window"
          confirmStyle={btnDanger}
          busy={busy}
          onConfirm={() => void runWindowToggle("end_window")}
          onCancel={() => setModal(null)}
        >
          <p style={{ marginTop: 0 }}>
            Ending the window stops tagging new documents. The registry keeps everything already tagged so you
            can review and clean up below.
          </p>
          <p>
            Follow-up per the runbook: run the reviewed cleanup, REVERSE any posted test documents through the
            normal posting flow (with a reason), and keep the ZZ-BETA master records.
          </p>
        </ConfirmModal>
      )}

      {modal === "cleanup" && (
        <ConfirmModal
          title={`Clean up ${selRows.length} selected row${selRows.length === 1 ? "" : "s"}`}
          confirmLabel={`Delete ${selDeletable.length} row${selDeletable.length === 1 ? "" : "s"}`}
          confirmStyle={btnDanger}
          busy={busy}
          onConfirm={() => void runCleanup()}
          onCancel={() => setModal(null)}
        >
          <p style={{ marginTop: 0 }}>
            The engine re-checks every row against live data at delete time. Posted or referenced documents
            refuse and stay untouched.
          </p>
          {selDeletable.length > 0 && (
            <>
              <div style={{ fontWeight: 700, color: C.success, marginBottom: 4 }}>
                Will be deleted ({selDeletable.length})
              </div>
              <ul style={{ marginTop: 0 }}>
                {selDeletable.slice(0, 30).map((r) => (
                  <li key={r.id}>{labelOf(r)} <span style={{ color: C.textMuted }}>({r.table_name})</span></li>
                ))}
                {selDeletable.length > 30 && <li style={{ color: C.textMuted }}>… and {selDeletable.length - 30} more</li>}
              </ul>
            </>
          )}
          {selRefused.length > 0 && (
            <>
              <div style={{ fontWeight: 700, color: C.warn, marginBottom: 4 }}>
                Will refuse ({selRefused.length})
              </div>
              <ul style={{ marginTop: 0 }}>
                {selRefused.slice(0, 30).map((r) => (
                  <li key={r.id}>
                    {labelOf(r)} <span style={{ color: C.textMuted }}>— {r.eligibility.reason}</span>
                  </li>
                ))}
                {selRefused.length > 30 && <li style={{ color: C.textMuted }}>… and {selRefused.length - 30} more</li>}
              </ul>
            </>
          )}
        </ConfirmModal>
      )}
    </div>
  );
}
