// src/tanda/InternalMonthEndClose.tsx
//
// Month-End Close — per-period close checklist with automated tie-out checks,
// manual sign-offs, and period locking.
//
// (a) Close-calendar strip: the last 12 periods with GL + close status.
// (b) Checklist for the selected month: 8 automated checks (run server-side by
//     close_run_auto_checks — GL balanced, AR/AP subledger ties, bank recon,
//     draft JEs, 8007 activity, factor 1107 tie, revenue sanity) + 6 manual
//     sign-off items (who/when/note).
// (c) Per-item drill: the numbers behind every verdict (detail jsonb).
// (d) Close period (all checks pass + all sign-offs) → locks gl_periods via
//     the audited transition RPC; Reopen with mandatory reason (admin only).

import React, { useCallback, useEffect, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog, promptDialog } from "../shared/ui/warn";
import { drillToModule, readDrillParam, consumeDrillParams, type DrillModuleKey } from "./scorecardDrill";

type StripRow = {
  month: string; // YYYY-MM
  period_id: string;
  fiscal_year: number;
  period_number: number;
  starts_on: string;
  ends_on: string;
  gl_status: string;
  close_status: string;
  checks_last_run_at: string | null;
  closed_at: string | null;
  items: { auto_pass: number; auto_fail: number; auto_pending: number; manual_signed: number; manual_pending: number };
};

type ChecklistItem = {
  id: string;
  item_key: string;
  label: string;
  kind: "auto" | "manual";
  status: "pending" | "pass" | "fail" | "signed_off";
  detail: Record<string, unknown>;
  signed_off_by_label: string | null;
  signed_off_at: string | null;
  note: string | null;
  sort_order: number;
  // Per-item review context (server-attached; BOTH manual sign-offs and auto
  // checks): what to review + a count for the period + the panel to open, plus
  // an optional filtered drill (draft JEs, account 8007). panel=null → no drill.
  review?: {
    summary: string;
    panel: string | null;
    drill?: Record<string, string>;
    count?: number;
    severity?: "info" | "warn" | "critical";
  };
};

type Checklist = {
  month: string;
  period: { fiscal_year: number; period_number: number; starts_on: string; ends_on: string; gl_status: string };
  close_period: { status: string; checks_last_run_at: string | null; closed_at: string | null } | null;
  items: ChecklistItem[];
  ready_to_close: boolean;
};

const C = {
  bg: "#0b1220", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  waived: "#64748B", // slate/grey-blue: explained, non-blocking exceptions
};

// Rich verdict of an auto check. The stored status column is only
// pass/fail (blocking semantics), so the true verdict lives in
// detail.classification: pass | fail | warn | waived. Manual items keep their
// own status. See migration 20260998000000 + closeChecklist.upsertAutoItems.
type RichStatus = "pass" | "fail" | "warn" | "waived" | "signed_off" | "pending";

function richStatus(item: ChecklistItem): RichStatus {
  if (item.kind === "auto") {
    const cls = String((item.detail || {}).classification || "");
    if (cls === "pass" || cls === "fail" || cls === "warn" || cls === "waived") return cls;
    return item.status === "pass" ? "pass" : "fail";
  }
  return item.status as RichStatus;
}

/** A check is a hard blocker for close only when its rich verdict is 'fail'. */
function isBlocker(item: ChecklistItem): boolean {
  return item.kind === "auto" && richStatus(item) === "fail";
}

const STATUS_META: Record<RichStatus, { label: string; color: string; glyph: string }> = {
  pass:       { label: "Pass",     color: C.success, glyph: "✓" },
  fail:       { label: "Blocker",  color: C.danger,  glyph: "✕" },
  warn:       { label: "Advisory", color: C.warn,    glyph: "!" },
  waived:     { label: "Waived",   color: C.waived,  glyph: "•" },
  signed_off: { label: "Signed off", color: C.success, glyph: "✓" },
  pending:    { label: "Pending",  color: C.textMuted, glyph: "•" },
};

const th: React.CSSProperties = {
  background: C.bg, color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2,
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13,
  verticalAlign: "top",
};
const btn: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontSize: 12,
};

function fmtCents(c: unknown): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

/** "2026-05" → "05/2026". */
function fmtMonth(m: string): string {
  const [y, mo] = m.split("-");
  return `${mo}/${y}`;
}

/** ISO timestamp → US MM/DD/YYYY HH:mm. */
function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Previous full calendar month, YYYY-MM. */
function prevMonthISO(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** One-line human summary of a check's detail jsonb. */
function detailSummary(item: ChecklistItem): string {
  const d = item.detail || {};
  switch (item.item_key) {
    case "gl_balanced":
      return `ACCRUAL off ${fmtCents(d.accrual_imbalance_cents)} · CASH off ${fmtCents(d.cash_imbalance_cents)} · ${d.posted_je_count ?? 0} posted JEs`;
    case "ar_subledger_tie": {
      const accts = Array.isArray(d.accounts) ? (d.accounts as Array<Record<string, unknown>>) : [];
      return accts.map((a) => `${a.account_code}: off ${fmtCents(a.diff_cents)}`).join(" · ") || "no data";
    }
    case "ap_subledger_tie":
      return `GL ${fmtCents(d.gl_cents)} vs bills ${fmtCents(d.subledger_cents)} → off ${fmtCents(d.diff_cents)}${d.waived ? " (waived: payments ledger not live)" : ""}`;
    case "bank_recon":
      return `${d.reconciled ?? 0}/${d.runs ?? 0} account-months reconciled${d.note ? ` — ${d.note}` : ""}`;
    case "no_draft_jes":
      return `${d.draft_je_count ?? 0} draft/unposted JEs in period`;
    case "uncategorized_8007":
      return `8007 activity ${fmtCents(d.accrual_net_cents)} (${d.line_count ?? 0} lines)`;
    case "factor_recon":
      return d.covered === false
        ? "no factor statement covers this month"
        : `Net OAR ${fmtCents(d.ending_net_oar_cents)} vs GL 1107 ${fmtCents(d.gl_1107_asof_cents)} → off ${fmtCents(d.diff_cents)}`;
    case "revenue_posted":
      return `revenue posted ${fmtCents(d.revenue_cents)}`;
    default:
      return item.kind === "manual"
        ? item.status === "signed_off"
          ? `signed off by ${item.signed_off_by_label || "operator"} ${fmtStamp(item.signed_off_at)}`
          : item.review?.summary || "awaiting sign-off"
        : "";
  }
}

function StatusChip({ item }: { item: ChecklistItem }) {
  const s = STATUS_META[richStatus(item)] || STATUS_META.pending;
  return (
    <span
      title={richStatus(item) === "waived" ? "Explained, non-blocking exception — see the recommendation" : undefined}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600,
        color: s.color, border: `1px solid ${s.color}55`, background: `${s.color}18`,
        borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap",
      }}
    >
      {s.glyph} {s.label}
    </span>
  );
}

/** Recursive-ish renderer for a check's detail jsonb (drill view). */
function DetailBlock({ detail }: { detail: Record<string, unknown> }) {
  // Prose fields (classification/severity/title/explanation/recommendation)
  // are surfaced in the card header, not the raw number drill.
  const HIDE = new Set(["ran_at", "classification", "severity", "title", "explanation", "recommendation"]);
  const entries = Object.entries(detail || {}).filter(([k]) => !HIDE.has(k));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0" }}>
      {entries.map(([k, v]) => {
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
          const rows = v as Array<Record<string, unknown>>;
          const cols = Object.keys(rows[0]);
          return (
            <div key={k} style={{ overflowX: "auto" }}>
              <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{k.replace(/_/g, " ")}</div>
              <table style={{ borderCollapse: "collapse" }}>
                <thead><tr>{cols.map((c) => <th key={c} style={{ ...th, position: "static", padding: "4px 10px" }}>{c.replace(/_/g, " ")}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {cols.map((c) => (
                        <td key={c} style={{ ...td, padding: "4px 10px", fontSize: 12, textAlign: /_cents$/.test(c) ? "right" : "left", fontVariantNumeric: "tabular-nums" }}>
                          {/_cents$/.test(c) ? fmtCents(r[c]) : typeof r[c] === "boolean" ? (r[c] ? "✓" : "✕") : String(r[c] ?? "—")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <div key={k} style={{ display: "flex", gap: 10, fontSize: 12 }}>
            <span style={{ color: C.textMuted, minWidth: 200 }}>{k.replace(/_/g, " ")}</span>
            <span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>
              {/_cents$/.test(k) ? fmtCents(v) : v == null ? "—" : String(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const EXPORT_COLUMNS = [
  { key: "label",               header: "Checklist Item" },
  { key: "kind",                header: "Kind" },
  { key: "status",              header: "Status" },
  { key: "summary",             header: "Detail" },
  { key: "signed_off_by_label", header: "Signed Off By" },
  { key: "signed_off_at_us",    header: "Signed Off At" },
  { key: "note",                header: "Note" },
] as ExportColumn<Record<string, unknown>>[];

export default function InternalMonthEndClose() {
  // Preselect the month when arrived at via the Today "prior months not closed"
  // drill (?month=YYYY-MM) so we land on the period that needs finishing; else
  // default to the previous calendar month. One-shot: consumed on mount.
  const [month, setMonth] = useState<string>(() => {
    const m = readDrillParam("month");
    return /^\d{4}-\d{2}$/.test(m) ? m : prevMonthISO();
  });
  const [strip, setStrip] = useState<StripRow[]>([]);
  const [data, setData] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const seqGuard = useSeqGuard();

  const loadStrip = useCallback(async () => {
    try {
      const r = await fetch("/api/internal/month-end-close/periods?months=12");
      if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error || `HTTP ${r.status}`);
      const j = await r.json();
      setStrip((j.rows || []).slice().reverse()); // oldest → newest
    } catch {
      /* strip is decorative — checklist errors surface below */
    }
  }, []);

  const loadChecklist = useCallback(async (m: string) => {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/month-end-close/checklist?month=${m}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error || `HTTP ${r.status}`);
      const j: Checklist = await r.json();
      if (!seqGuard.isCurrent(seq)) return;
      setData(j);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) { setErr(e instanceof Error ? e.message : String(e)); setData(null); }
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }, [seqGuard]);

  useEffect(() => { loadStrip(); }, [loadStrip]);
  useEffect(() => { loadChecklist(month); }, [month, loadChecklist]);
  useEffect(() => { consumeDrillParams(["month"]); }, []);

  async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; json: { error?: string; blocking?: Array<{ label: string }> } }> {
    const r = await fetch(`/api/internal/month-end-close/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, json };
  }

  async function runChecks() {
    setRunning(true);
    try {
      const { ok, json } = await post("run-checks", { month });
      if (!ok) throw new Error(json.error || "run-checks failed");
      notify("Checks complete", "success");
      await Promise.all([loadChecklist(month), loadStrip()]);
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRunning(false);
    }
  }

  async function signOff(item: ChecklistItem, undo: boolean) {
    // Surface the review context in the prompt so the operator sees exactly what
    // they are attesting to (e.g. "…— 3 open chargebacks. What did you review?").
    const ctx = !undo && item.review?.summary ? ` — ${item.review.summary}` : "";
    const note = await promptDialog(
      undo
        ? `Reverting the sign-off on "${item.label}". Why?`
        : `Signing off "${item.label}" for ${fmtMonth(month)}${ctx}. What did you review?`,
      { title: undo ? "Revert sign-off" : "Sign off", multiline: true, required: true, confirmText: undo ? "Revert" : "Sign off" },
    );
    if (note == null || !note.trim()) return;
    const { ok, json } = await post("sign-off", { month, item_key: item.item_key, note: note.trim(), undo });
    if (!ok) { notify(json.error || "Sign-off failed", "error"); return; }
    notify(undo ? "Sign-off reverted" : "Signed off", "success");
    await Promise.all([loadChecklist(month), loadStrip()]);
  }

  /** Open the panel that lets the operator review a manual item before signing. */
  function openReview(item: ChecklistItem) {
    const panel = item.review?.panel;
    if (!panel) return;
    drillToModule(panel as DrillModuleKey, item.review?.drill || {});
  }

  async function closePeriod() {
    const sure = await confirmDialog(
      `Close ${fmtMonth(month)}? Posting into this period will be locked (reopen requires an admin with a reason).`,
      { title: "Close period", confirmText: "Close period" },
    );
    if (!sure) return;
    const reason = await promptDialog(`Reason for closing ${fmtMonth(month)} (recorded in the period audit log):`, {
      title: "Close period", multiline: true, required: true, confirmText: "Close",
    });
    if (reason == null || !reason.trim()) return;
    const { ok, json } = await post("close", { month, reason: reason.trim() });
    if (!ok) {
      const blocking = (json.blocking || []).map((b) => b.label);
      notify(json.error ? `${json.error}${blocking.length ? ` — ${blocking.join(", ")}` : ""}` : "Close failed", "error");
      return;
    }
    notify(`${fmtMonth(month)} closed`, "success");
    await Promise.all([loadChecklist(month), loadStrip()]);
  }

  async function reopenPeriod() {
    const sure = await confirmDialog(
      `Reopen ${fmtMonth(month)}? The GL period unlocks and the close must be re-certified.`,
      { title: "Reopen period", danger: true, confirmText: "Reopen" },
    );
    if (!sure) return;
    const reason = await promptDialog(`Reason for reopening ${fmtMonth(month)} (mandatory, audit-logged):`, {
      title: "Reopen period", multiline: true, required: true, confirmText: "Reopen",
    });
    if (reason == null || !reason.trim()) return;
    const { ok, json } = await post("reopen", { month, reason: reason.trim() });
    if (!ok) { notify(json.error || "Reopen failed", "error"); return; }
    notify(`${fmtMonth(month)} reopened`, "success");
    await Promise.all([loadChecklist(month), loadStrip()]);
  }

  const items = data?.items || [];
  const autos = items.filter((i) => i.kind === "auto");
  const manuals = items.filter((i) => i.kind === "manual");
  const blockers = autos.filter(isBlocker);
  const advisories = autos.filter((i) => richStatus(i) === "warn");
  const waivedItems = autos.filter((i) => richStatus(i) === "waived");
  const passItems = autos.filter((i) => richStatus(i) === "pass");
  const exceptions = advisories.length + waivedItems.length;
  const manualsPending = manuals.filter((i) => i.status !== "signed_off").length;
  const glStatus = data?.period.gl_status || "—";
  const closeStatus = data?.close_period?.status || "open";
  const isClosed = closeStatus === "closed" || glStatus === "closed" || glStatus === "closed_with_closing_jes";

  const exportRows = items.map((i) => {
    const expl = typeof (i.detail || {}).explanation === "string" ? String((i.detail || {}).explanation) : "";
    return {
      label: i.label,
      kind: i.kind,
      status: STATUS_META[richStatus(i)]?.label || i.status,
      summary: expl || detailSummary(i),
      signed_off_by_label: i.signed_off_by_label || "",
      signed_off_at_us: fmtStamp(i.signed_off_at),
      note: i.note || "",
    };
  }) as Array<Record<string, unknown>>;

  const stripColor = (r: StripRow): string =>
    r.close_status === "closed" || r.gl_status === "closed" || r.gl_status === "closed_with_closing_jes"
      ? C.success
      : r.close_status === "in_close"
        ? (r.items.auto_fail > 0 ? C.warn : C.primary)
        : C.textMuted;

  const renderRow = (item: ChecklistItem) => {
    const isOpen = !!expanded[item.item_key];
    const d = item.detail || {};
    const explanation = typeof d.explanation === "string" ? d.explanation : "";
    const recommendation = typeof d.recommendation === "string" ? d.recommendation : "";
    const rs = richStatus(item);
    const accent = STATUS_META[rs]?.color || C.textMuted;
    return (
      <React.Fragment key={item.item_key}>
        <tr>
          <td style={{ ...td, width: 26, cursor: "pointer", userSelect: "none", borderLeft: `3px solid ${accent}` }} onClick={() => setExpanded((e) => ({ ...e, [item.item_key]: !isOpen }))}>
            <span style={{ color: C.textMuted }}>{isOpen ? "▾" : "▸"}</span>
          </td>
          <td style={{ ...td, cursor: "pointer" }} onClick={() => setExpanded((e) => ({ ...e, [item.item_key]: !isOpen }))}>
            <div style={{ fontWeight: 600 }}>{item.label}</div>
            {/* Plain-language WHAT it means. */}
            <div style={{ color: C.textSub, fontSize: 12, marginTop: 3, lineHeight: 1.45 }}>
              {explanation || detailSummary(item)}
            </div>
            {/* Plain-language WHAT to do — only when there is an action to take. */}
            {recommendation && recommendation !== "No action needed." && (
              <div style={{ color: accent, fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>
                <b style={{ fontWeight: 700 }}>Next: </b>{recommendation}
              </div>
            )}
            {/* Review link (auto checks) — jump to the underlying item(s) that
                need review/checking: a blocker's/advisory's/waived item's source
                (draft JEs filtered, 8007 in GL Detail, the relevant aging /
                statement). Shown regardless of verdict so the operator can always
                inspect; a passing check keeps it subtle. Blue, no drill arrow. */}
            {item.kind === "auto" && item.review?.panel && (
              <div style={{ marginTop: 5 }}>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); openReview(item); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openReview(item); } }}
                  style={{ color: C.primary, cursor: "pointer", fontSize: 12, fontWeight: rs === "pass" ? 400 : 600, opacity: rs === "pass" ? 0.75 : 1, textDecoration: "underline" }}
                  title="Open the underlying item(s) to review"
                >
                  Review{typeof item.review.count === "number" ? ` (${item.review.count})` : ""}
                </span>
              </div>
            )}
            {/* Review link — open the panel that backs this manual item so the
                operator can actually review before signing. Blue identifier, no
                drill arrow (house rule). panel=null (controller sign-off) → none. */}
            {item.kind === "manual" && item.review?.panel && item.status !== "signed_off" && (
              <div style={{ marginTop: 5 }}>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); openReview(item); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openReview(item); } }}
                  style={{ color: C.primary, cursor: "pointer", fontSize: 12, fontWeight: 600, textDecoration: "underline" }}
                  title="Open the panel to review before signing off"
                >
                  Review{typeof item.review.count === "number" ? ` (${item.review.count})` : ""}
                </span>
              </div>
            )}
            {item.note && <div style={{ color: C.textSub, fontSize: 12, marginTop: 3, fontStyle: "italic" }}>“{item.note}”</div>}
          </td>
          <td style={{ ...td, whiteSpace: "nowrap" }}><StatusChip item={item} /></td>
          <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
            {item.kind === "manual" && !isClosed && (
              item.status === "signed_off"
                ? <button style={btn} onClick={() => signOff(item, true)}>↺ Revert</button>
                : <button style={{ ...btn, color: C.success, borderColor: `${C.success}66` }} onClick={() => signOff(item, false)}>✓ Sign off</button>
            )}
          </td>
        </tr>
        {isOpen && (
          <tr>
            <td style={{ ...td, borderLeft: `3px solid ${accent}` }} />
            <td style={{ ...td, background: C.bg }} colSpan={3}>
              {item.kind === "manual" ? (
                <div style={{ fontSize: 12, color: C.textSub, padding: "4px 0" }}>
                  {item.status === "signed_off"
                    ? `Signed off by ${item.signed_off_by_label || "operator"} on ${fmtStamp(item.signed_off_at)}.`
                    : (
                      <>
                        {item.review?.summary ? <div style={{ marginBottom: 4 }}>{item.review.summary}</div> : null}
                        <div>Awaiting operator sign-off. A note describing what was reviewed is required.</div>
                        {item.review?.panel && (
                          <div style={{ marginTop: 4 }}>
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => { e.stopPropagation(); openReview(item); }}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openReview(item); } }}
                              style={{ color: C.primary, cursor: "pointer", fontWeight: 600, textDecoration: "underline" }}
                            >
                              Review{typeof item.review.count === "number" ? ` (${item.review.count})` : ""}
                            </span>
                          </div>
                        )}
                      </>
                    )}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>The numbers behind this verdict</div>
                  <DetailBlock detail={item.detail} />
                </>
              )}
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  return (
    <div style={{ padding: 20, color: C.text }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Month-End Close</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button style={btn} onClick={() => setMonth((m) => shiftMonth(m, -1))} title="Previous month">◀</button>
          <span style={{ fontSize: 15, fontWeight: 700, minWidth: 76, textAlign: "center" }}>{fmtMonth(month)}</span>
          <button style={btn} onClick={() => setMonth((m) => shiftMonth(m, 1))} title="Next month">▶</button>
        </div>
        <div style={{ flex: 1 }} />
        <button style={{ ...btn, color: C.primary, borderColor: `${C.primary}66` }} onClick={runChecks} disabled={running}>
          {running ? "Running…" : "Run checks"}
        </button>
        {!isClosed && (
          <button
            style={{ ...btn, color: C.success, borderColor: `${C.success}66`, opacity: data?.ready_to_close ? 1 : 0.5 }}
            disabled={!data?.ready_to_close}
            title={data?.ready_to_close ? "Lock this period" : "Every automated check must pass and every manual item must be signed off"}
            onClick={closePeriod}
          >
            Close period
          </button>
        )}
        {isClosed && glStatus !== "closed_with_closing_jes" && (
          <button style={{ ...btn, color: C.warn, borderColor: `${C.warn}66` }} onClick={reopenPeriod}>Reopen</button>
        )}
        <ExportButton rows={exportRows} columns={EXPORT_COLUMNS} filename={`month-end-close-${month}`} sheetName="Close Checklist" />
      </div>

      {/* Close-calendar strip (last 12 periods) */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {strip.map((r) => {
          const color = stripColor(r);
          const active = r.month === month;
          return (
            <button
              key={r.month}
              onClick={() => setMonth(r.month)}
              title={`GL: ${r.gl_status} · close: ${r.close_status} · auto ${r.items.auto_pass}✓/${r.items.auto_fail}✕ · sign-offs ${r.items.manual_signed}/${r.items.manual_signed + r.items.manual_pending}`}
              style={{
                ...btn,
                padding: "4px 9px",
                color,
                borderColor: active ? color : `${color}55`,
                background: active ? `${color}22` : "transparent",
                fontWeight: active ? 700 : 400,
              }}
            >
              {fmtMonth(r.month)}
            </button>
          );
        })}
      </div>

      {/* Status summary */}
      {data && (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
          <span><span style={{ color: C.textMuted }}>GL period: </span><b>{glStatus}</b></span>
          <span><span style={{ color: C.textMuted }}>Close status: </span><b style={{ color: closeStatus === "closed" ? C.success : closeStatus === "in_close" ? C.primary : C.textSub }}>{closeStatus.replace("_", " ")}</b></span>
          <span><span style={{ color: C.textMuted }}>Checks last run: </span><b>{fmtStamp(data.close_period?.checks_last_run_at)}</b></span>
          <span><span style={{ color: C.textMuted }}>Blockers: </span><b style={{ color: blockers.length > 0 ? C.danger : C.success }}>{blockers.length}</b></span>
          <span><span style={{ color: C.textMuted }}>Advisory: </span><b style={{ color: advisories.length > 0 ? C.warn : C.textSub }}>{advisories.length}</b></span>
          <span><span style={{ color: C.textMuted }}>Waived: </span><b style={{ color: waivedItems.length > 0 ? C.waived : C.textSub }}>{waivedItems.length}</b></span>
          <span><span style={{ color: C.textMuted }}>Pass: </span><b style={{ color: C.success }}>{passItems.length}/{autos.length}</b></span>
          <span><span style={{ color: C.textMuted }}>Sign-offs: </span><b style={{ color: manuals.every((i) => i.status === "signed_off") && manuals.length > 0 ? C.success : C.textSub }}>{manuals.filter((i) => i.status === "signed_off").length}/{manuals.length}</b></span>
        </div>
      )}

      {/* Plain-language close-readiness banner: what stands between you and a
          finalized close, and how to get there. */}
      {data && data.close_period && !isClosed && (
        (() => {
          const [msg, color] = blockers.length > 0
            ? [`${blockers.length} blocker${blockers.length > 1 ? "s" : ""} must be fixed before this month can close. Blockers are marked in red below — each card explains what to do.`, C.danger]
            : manualsPending > 0
              ? [`No blockers. ${exceptions > 0 ? `${exceptions} check${exceptions > 1 ? "s are" : " is"} a documented, non-blocking exception (Advisory / Waived — explained on each card). ` : ""}Sign off the ${manualsPending} remaining manual item${manualsPending > 1 ? "s" : ""}, then Close period.`, C.primary]
              : [`Ready to close${exceptions > 0 ? ` with ${exceptions} documented exception${exceptions > 1 ? "s" : ""}` : ""}. Use Close period (a reason is recorded in the audit log).`, C.success];
          return (
            <div style={{ background: `${color}14`, border: `1px solid ${color}55`, color: C.text, borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
              <b style={{ color }}>{blockers.length > 0 ? "Not ready to close" : manualsPending > 0 ? "Almost ready" : "Ready to close"}</b>
              <span style={{ color: C.textSub }}> — {msg}</span>
            </div>
          );
        })()
      )}

      {err && <div style={{ color: C.danger, marginBottom: 12 }}>{err}</div>}
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}

      {!loading && data && !data.close_period && (
        <div style={{ background: C.card, border: `1px dashed ${C.cardBdr}`, borderRadius: 8, padding: 24, textAlign: "center", color: C.textMuted }}>
          The close for {fmtMonth(month)} has not started. <b style={{ color: C.text }}>Run checks</b> to build the checklist.
        </div>
      )}

      {!loading && data && data.close_period && (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 26 }} />
                  <th style={th}>Checklist Item</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                <tr><td colSpan={4} style={{ ...td, background: C.bg, color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Automated checks</td></tr>
                {autos.map(renderRow)}
                <tr><td colSpan={4} style={{ ...td, background: C.bg, color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Manual sign-offs</td></tr>
                {manuals.map(renderRow)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
