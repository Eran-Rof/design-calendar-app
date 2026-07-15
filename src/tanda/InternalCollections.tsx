// src/tanda/InternalCollections.tsx
//
// AR Collections — the operating tool that turns overdue AR into a managed
// process. Reads /api/internal/ar-collections/* (worklist rollup, per-customer
// invoices, activity timeline, KPI summary, promise pipeline) and writes
// operator activities (notes / calls / promises-to-pay / disputes / escalations)
// via POST. It NEVER posts to the GL and NEVER mutates invoices.
//
// Layout:
//   • KPI header — overdue $, # accounts, promised $, broken promises, DSO.
//   • Worklist grid (per-customer roll-up) — sortable, filterable; full-row
//     click opens a per-customer collections drawer (aging summary, the open
//     invoices, the activity timeline, and a Log-activity form).
//   • Promises view — the promise-to-pay pipeline (upcoming / due today / broken).
//   • Factored invoices (Rosenthal collects) are badged and excludable.

import { useCallback, useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify } from "../shared/ui/warn";
import {
  fmtCents,
  fmtDateUS,
  rollupBuckets,
  BUCKET_ORDER,
  BUCKET_COLOR,
  type BucketKey,
} from "../lib/collections";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155", input: "#0b1220",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const STATUS_COLOR: Record<string, string> = {
  current: C.textSub, watch: "#FACC15", overdue: "#FB923C",
  promised: C.success, disputed: "#A78BFA", escalated: C.danger, in_collections: "#DC2626",
};

const ACTIVITY_TYPES = [
  { key: "note", label: "Note" },
  { key: "call", label: "Call" },
  { key: "email", label: "Email" },
  { key: "promise_to_pay", label: "Promise to pay" },
  { key: "dispute", label: "Dispute" },
  { key: "escalation", label: "Escalate" },
  { key: "payment_expected", label: "Payment expected" },
] as const;

type Rollup = {
  entity_id: string;
  customer_id: string;
  customer_name: string | null;
  customer_code: string | null;
  is_factored: boolean;
  open_invoice_count: number;
  open_cents: number;
  severely_past_due_cents: number | null;
  max_days_past_due: number;
  last_activity_at: string | null;
  assigned_owner_user_id: string | null;
  next_action_date: string | null;
  has_open_promise: boolean;
  has_broken_promise: boolean;
};

type WorklistInvoice = {
  ar_invoice_id: string;
  customer_id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  open_cents: number;
  days_past_due: number;
  age_bucket: BucketKey;
  is_factored: boolean;
  collection_status: string;
  open_promise_amount_cents: number | null;
  open_promise_date: string | null;
  promise_broken: boolean;
  last_activity_type: string | null;
  last_activity_at: string | null;
};

type Activity = {
  id: string;
  ar_invoice_id: string | null;
  activity_type: string;
  promise_amount_cents: number | null;
  promise_date: string | null;
  outcome: string;
  created_at: string;
};

type PromiseRow = {
  activity_id: string;
  customer_id: string;
  customer_name: string | null;
  customer_code: string | null;
  ar_invoice_id: string | null;
  invoice_number: string | null;
  promise_amount_cents: number | null;
  promise_date: string | null;
  outcome: string;
  promise_state: "upcoming" | "due_today" | "broken";
};

type Kpi = {
  ours: { open_cents: number; accounts: number; invoices: number; overdue_cents: number; overdue_accounts: number };
  by_bucket: Record<string, { open_cents: number; invoices: number; accounts: number }>;
  factored: { open_cents: number; accounts: number };
  promised_cents: number; promised_count: number;
  broken_promise_cents: number; broken_promise_count: number;
  dso: Array<{ month: string; days: number }>;
};

// ── shared styles ───────────────────────────────────────────────────────────
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "#fff", border: "none",
  padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: C.input, color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };
const th: React.CSSProperties = {
  background: C.input, color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const blueLink: React.CSSProperties = { color: C.primary, fontWeight: 600 };

function StatusBadge({ status }: { status: string }) {
  const col = STATUS_COLOR[status] || C.textMuted;
  return (
    <span style={{
      display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11,
      color: col, border: `1px solid ${col}`, background: "transparent", whiteSpace: "nowrap",
    }}>{status.replace(/_/g, " ")}</span>
  );
}

function FactoredBadge() {
  return (
    <span title="Factored — Rosenthal collects this invoice" style={{
      display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11,
      color: "#A78BFA", border: "1px solid #A78BFA", marginLeft: 6, whiteSpace: "nowrap",
    }}>Factored · Rosenthal</span>
  );
}

function KpiTile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px", minWidth: 150 }}>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || C.text, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function InternalCollections() {
  const [view, setView] = useState<"worklist" | "promises">("worklist");
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [rows, setRows] = useState<Rollup[]>([]);
  const [promiseRows, setPromiseRows] = useState<PromiseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // filters
  const [excludeFactored, setExcludeFactored] = useState(true);
  const [bucket, setBucket] = useState("");
  const [status, setStatus] = useState("");
  const [hasPromise, setHasPromise] = useState("");
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<"open_cents" | "max_days_past_due">("open_cents");

  const [drawer, setDrawer] = useState<Rollup | null>(null);

  const loadKpi = useCallback(async () => {
    try {
      const r = await fetch("/api/internal/ar-collections/summary");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setKpi((await r.json()).kpi as Kpi);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  const loadWorklist = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ group: "customer" });
      if (excludeFactored) p.set("exclude_factored", "1");
      if (status) p.set("status", status);
      if (hasPromise) p.set("has_promise", hasPromise);
      if (q.trim()) p.set("q", q.trim());
      const r = await fetch(`/api/internal/ar-collections?${p.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(((await r.json()).rows || []) as Rollup[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [excludeFactored, status, hasPromise, q]);

  const loadPromises = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ latest: "1" });
      const r = await fetch(`/api/internal/ar-collections/promises?${p.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setPromiseRows(((await r.json()).rows || []) as PromiseRow[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadKpi(); }, [loadKpi]);
  useEffect(() => {
    if (view === "worklist") void loadWorklist();
    else void loadPromises();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, excludeFactored, status, hasPromise]);

  const refreshAll = useCallback(() => {
    void loadKpi();
    if (view === "worklist") void loadWorklist(); else void loadPromises();
  }, [loadKpi, loadWorklist, loadPromises, view]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => Number(b[sortKey] || 0) - Number(a[sortKey] || 0));
    if (bucket) {
      // bucket filter is invoice-level; approximate at the account level by
      // keeping accounts whose worst bucket reaches the selected one.
      const order = BUCKET_ORDER.indexOf(bucket as BucketKey);
      return copy.filter((r) => {
        const worst = r.max_days_past_due <= 0 ? 0 : r.max_days_past_due <= 30 ? 1 : r.max_days_past_due <= 60 ? 2 : r.max_days_past_due <= 90 ? 3 : r.max_days_past_due <= 120 ? 4 : 5;
        return worst >= order;
      });
    }
    return copy;
  }, [rows, sortKey, bucket]);

  const totalOpen = useMemo(() => sortedRows.reduce((s, r) => s + Number(r.open_cents || 0), 0), [sortedRows]);
  const latestDso = kpi?.dso?.[0];

  const promiseGroups = useMemo(() => {
    const g = { upcoming: [] as PromiseRow[], due_today: [] as PromiseRow[], broken: [] as PromiseRow[] };
    for (const p of promiseRows) g[p.promise_state].push(p);
    return g;
  }, [promiseRows]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Collections</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          Open house/CC AR you collect. Factored invoices are Rosenthal's — badged and excludable.
        </div>
      </div>

      {/* KPI header */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <KpiTile label="Overdue (ours)" value={fmtCents(kpi?.ours.overdue_cents)} sub={`${kpi?.ours.overdue_accounts ?? 0} accounts · ${kpi?.ours.invoices ?? 0} invoices`} color={C.warn} />
        <KpiTile label="Open promises" value={fmtCents(kpi?.promised_cents)} sub={`${kpi?.promised_count ?? 0} promises`} color={C.success} />
        <KpiTile label="Broken promises" value={fmtCents(kpi?.broken_promise_cents)} sub={`${kpi?.broken_promise_count ?? 0} broken`} color={C.danger} />
        <KpiTile label="Current DSO" value={latestDso ? `${latestDso.days} d` : "—"} sub={latestDso ? fmtDateUS(latestDso.month) : undefined} color={C.primary} />
        <KpiTile label="Factored (Rosenthal)" value={fmtCents(kpi?.factored.open_cents)} sub={`${kpi?.factored.accounts ?? 0} accounts · not ours to dun`} color={C.textSub} />
      </div>

      {/* View toggle */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setView("worklist")} style={view === "worklist" ? btnPrimary : btnSecondary}>Worklist</button>
        <button onClick={() => setView("promises")} style={view === "promises" ? btnPrimary : btnSecondary}>Promises</button>
        <button onClick={refreshAll} style={btnSecondary}>Refresh</button>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>
      )}

      {view === "worklist" ? (
        <>
          {/* filters */}
          <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <input type="text" placeholder="Filter customer name or code…" value={q}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void loadWorklist(); }}
              style={{ ...inputStyle, width: 240 }} />
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
              <option value="">All statuses</option>
              {["current", "watch", "overdue", "promised", "disputed", "escalated", "in_collections"].map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
            <select value={bucket} onChange={(e) => setBucket(e.target.value)} style={selectStyle}>
              <option value="">All ages</option>
              {BUCKET_ORDER.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select value={hasPromise} onChange={(e) => setHasPromise(e.target.value)} style={selectStyle}>
              <option value="">Any promise</option>
              <option value="open">Has open promise</option>
              <option value="broken">Has broken promise</option>
            </select>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as typeof sortKey)} style={selectStyle}>
              <option value="open_cents">Sort: amount</option>
              <option value="max_days_past_due">Sort: days past due</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, cursor: "pointer" }}>
              <input type="checkbox" checked={excludeFactored} onChange={(e) => setExcludeFactored(e.target.checked)} />
              Exclude factored (Rosenthal)
            </label>
            <ExportButton
              rows={sortedRows as unknown as Array<Record<string, unknown>>}
              filename="ar-collections-worklist"
              sheetName="Collections"
              columns={[
                { key: "customer_code", header: "Code" },
                { key: "customer_name", header: "Customer" },
                { key: "open_invoice_count", header: "Open Invoices" },
                { key: "open_cents", header: "Open", format: "currency_cents" },
                { key: "severely_past_due_cents", header: "61+ Past Due", format: "currency_cents" },
                { key: "max_days_past_due", header: "Max DPD", format: "number" },
                { key: "next_action_date", header: "Next Action" },
                { key: "is_factored", header: "Factored" },
              ] as ExportColumn<Record<string, unknown>>[]}
            />
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 380px)", overflowY: "auto" }}>
            {loading ? (
              <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
            ) : sortedRows.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No accounts with open AR match the filters.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Customer</th>
                    <th style={{ ...th, textAlign: "right" }}>Open Invoices</th>
                    <th style={{ ...th, textAlign: "right" }}>Open Balance</th>
                    <th style={{ ...th, textAlign: "right" }}>61+ Past Due</th>
                    <th style={{ ...th, textAlign: "right" }}>Max DPD</th>
                    <th style={th}>Flags</th>
                    <th style={th}>Last Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => (
                    <tr key={r.customer_id} onClick={() => setDrawer(r)} style={{ cursor: "pointer" }}
                      title="Open the collections drawer for this account">
                      <td style={td}>
                        <span style={blueLink}>{r.customer_name || r.customer_code || "—"}</span>
                        {r.customer_code && r.customer_name && (
                          <span style={{ color: C.textMuted, marginLeft: 6, fontSize: 11 }}>({r.customer_code})</span>
                        )}
                        {r.is_factored && <FactoredBadge />}
                      </td>
                      <td style={tdNum}>{r.open_invoice_count}</td>
                      <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(r.open_cents)}</td>
                      <td style={{ ...tdNum, color: Number(r.severely_past_due_cents) > 0 ? C.danger : C.textMuted }}>{fmtCents(r.severely_past_due_cents)}</td>
                      <td style={{ ...tdNum, color: r.max_days_past_due > 90 ? C.danger : r.max_days_past_due > 0 ? C.warn : C.textMuted }}>{r.max_days_past_due}</td>
                      <td style={td}>
                        {r.has_open_promise && <span style={{ color: C.success, fontSize: 11, marginRight: 8 }}>promise</span>}
                        {r.has_broken_promise && <span style={{ color: C.danger, fontSize: 11, marginRight: 8 }}>broken</span>}
                        {r.next_action_date && <span style={{ color: C.textMuted, fontSize: 11 }}>next {fmtDateUS(r.next_action_date)}</span>}
                      </td>
                      <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>
                        {r.last_activity_at ? fmtDateUS(r.last_activity_at.slice(0, 10)) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#111827" }}>
                    <td style={{ ...td, fontWeight: 700, color: C.textSub }}>TOTAL ({sortedRows.length})</td>
                    <td style={tdNum} />
                    <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totalOpen)}</td>
                    <td colSpan={4} style={td} />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </>
      ) : (
        <PromisesView groups={promiseGroups} loading={loading} onOpenCustomer={(cid) => {
          const row = rows.find((r) => r.customer_id === cid);
          if (row) setDrawer(row);
          else setDrawer({ customer_id: cid } as Rollup);
        }} />
      )}

      {drawer && (
        <CollectionsDrawer account={drawer} onClose={() => setDrawer(null)} onChange={refreshAll} />
      )}
    </div>
  );
}

// ── Promises pipeline view ──────────────────────────────────────────────────
function PromisesView({ groups, loading, onOpenCustomer }: {
  groups: { upcoming: PromiseRow[]; due_today: PromiseRow[]; broken: PromiseRow[] };
  loading: boolean;
  onOpenCustomer: (customerId: string) => void;
}) {
  const cols = [
    { key: "customer_name", header: "Customer" },
    { key: "invoice_number", header: "Invoice" },
    { key: "promise_amount_cents", header: "Amount", format: "currency_cents" },
    { key: "promise_date", header: "Promise Date" },
    { key: "promise_state", header: "State" },
    { key: "outcome", header: "Outcome" },
  ] as ExportColumn<Record<string, unknown>>[];
  const all = [...groups.broken, ...groups.due_today, ...groups.upcoming];

  const section = (title: string, list: PromiseRow[], color: string) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color, marginBottom: 6 }}>{title} ({list.length})</div>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        {list.length === 0 ? (
          <div style={{ padding: 14, color: C.textMuted, fontSize: 12 }}>None.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>Customer</th><th style={th}>Invoice</th>
              <th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Promise Date</th><th style={th}>Outcome</th>
            </tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.activity_id}>
                  <td style={td}><span style={blueLink} onClick={() => onOpenCustomer(p.customer_id)} title="Open account">{p.customer_name || p.customer_code || "—"}</span></td>
                  <td style={{ ...td, color: C.textMuted }}>{p.invoice_number || "account-level"}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(p.promise_amount_cents)}</td>
                  <td style={td}>{fmtDateUS(p.promise_date)}</td>
                  <td style={{ ...td, color: C.textSub, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );

  if (loading) return <div style={{ padding: 20, color: C.textMuted }}>Loading…</div>;
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <ExportButton rows={all as unknown as Array<Record<string, unknown>>} filename="ar-collections-promises" sheetName="Promises" columns={cols} />
      </div>
      {section("Broken — follow up now", groups.broken, C.danger)}
      {section("Due today", groups.due_today, C.warn)}
      {section("Upcoming", groups.upcoming, C.success)}
    </div>
  );
}

// ── Per-customer collections drawer ─────────────────────────────────────────
function CollectionsDrawer({ account, onClose, onChange }: {
  account: Rollup; onClose: () => void; onChange: () => void;
}) {
  const [invoices, setInvoices] = useState<WorklistInvoice[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);

  // Log-activity form
  const [type, setType] = useState<string>("call");
  const [outcome, setOutcome] = useState("");
  const [scopeInvoice, setScopeInvoice] = useState<string>(""); // "" = account-level
  const [promiseAmount, setPromiseAmount] = useState("");
  const [promiseDate, setPromiseDate] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [invR, actR] = await Promise.all([
        fetch(`/api/internal/ar-collections?group=invoice&customer=${account.customer_id}`),
        fetch(`/api/internal/ar-collections/activities?customer=${account.customer_id}`),
      ]);
      const invJson = invR.ok ? await invR.json() : { rows: [] };
      const actJson = actR.ok ? await actR.json() : { rows: [] };
      setInvoices((invJson.rows || []) as WorklistInvoice[]);
      setTruncated(Boolean(invJson.truncated));
      setActivities((actJson.rows || []) as Activity[]);
    } finally { setLoading(false); }
  }, [account.customer_id]);

  useEffect(() => { void load(); }, [load]);

  const buckets = useMemo(() => rollupBuckets(invoices), [invoices]);
  const openTotal = useMemo(() => invoices.reduce((s, i) => s + Number(i.open_cents || 0), 0), [invoices]);

  async function submit() {
    if (!outcome.trim()) { notify("Outcome is required", "error"); return; }
    if (type === "promise_to_pay") {
      const amt = Math.round(Number(promiseAmount) * 100);
      if (!Number.isFinite(amt) || amt <= 0) { notify("Enter a promise amount", "error"); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(promiseDate)) { notify("Enter a promise date", "error"); return; }
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        customer_id: account.customer_id,
        ar_invoice_id: scopeInvoice || null,
        activity_type: type,
        outcome: outcome.trim(),
      };
      if (type === "promise_to_pay") {
        body.promise_amount_cents = Math.round(Number(promiseAmount) * 100);
        body.promise_date = promiseDate;
      }
      const r = await fetch("/api/internal/ar-collections/activities", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Activity logged", "success");
      setOutcome(""); setPromiseAmount(""); setPromiseDate("");
      await load();
      onChange();
    } catch (e) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 60, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(720px, 95vw)", maxHeight: "100vh", height: "100vh", background: C.bg,
        borderLeft: `1px solid ${C.cardBdr}`, display: "flex", flexDirection: "column",
      }}>
        {/* header */}
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>
              {account.customer_name || account.customer_code || "Account"}
              {account.is_factored && <FactoredBadge />}
            </div>
            <div style={{ fontSize: 12, color: C.textMuted }}>
              {account.customer_code} · {invoices.length} open invoices · {fmtCents(openTotal)} open
              {truncated && <span style={{ color: C.warn }}> · showing first page (large account)</span>}
            </div>
          </div>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>

        {/* scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          {/* aging summary */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {BUCKET_ORDER.map((b) => (
              <div key={b} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "6px 10px", minWidth: 92 }}>
                <div style={{ fontSize: 10, color: BUCKET_COLOR[b], textTransform: "uppercase" }}>{b}</div>
                <div style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCents(buckets[b])}</div>
              </div>
            ))}
          </div>

          {/* log activity form */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Log activity</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              <select value={type} onChange={(e) => setType(e.target.value)} style={selectStyle}>
                {ACTIVITY_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <select value={scopeInvoice} onChange={(e) => setScopeInvoice(e.target.value)} style={{ ...selectStyle, maxWidth: 260 }}>
                <option value="">Account-level (all invoices)</option>
                {invoices.slice(0, 300).map((i) => (
                  <option key={i.ar_invoice_id} value={i.ar_invoice_id}>#{i.invoice_number} · {fmtCents(i.open_cents)}</option>
                ))}
              </select>
            </div>
            {type === "promise_to_pay" && (
              <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <label style={{ fontSize: 12, color: C.textSub, display: "flex", flexDirection: "column", gap: 4 }}>
                  Promise amount ($)
                  <input type="number" min="0" step="0.01" value={promiseAmount} onChange={(e) => setPromiseAmount(e.target.value)} style={{ ...inputStyle, width: 160 }} />
                </label>
                <label style={{ fontSize: 12, color: C.textSub, display: "flex", flexDirection: "column", gap: 4 }}>
                  Promise date (MM/DD/YYYY)
                  <input type="date" value={promiseDate} onChange={(e) => setPromiseDate(e.target.value)} style={{ ...inputStyle, width: 170 }} />
                </label>
              </div>
            )}
            <textarea placeholder="Outcome / next step (required)…" value={outcome} onChange={(e) => setOutcome(e.target.value)}
              style={{ ...inputStyle, width: "100%", minHeight: 64, resize: "vertical", marginBottom: 10 }} />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => void submit()} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Log activity"}
              </button>
            </div>
          </div>

          {/* activity timeline */}
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Activity timeline</div>
          {activities.length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 16 }}>No activity logged yet.</div>
          ) : (
            <div style={{ marginBottom: 18 }}>
              {activities.map((a) => (
                <div key={a.id} style={{ borderLeft: `2px solid ${STATUS_COLOR[a.activity_type] || C.cardBdr}`, padding: "4px 0 10px 12px", marginLeft: 4 }}>
                  <div style={{ fontSize: 12, color: C.textMuted }}>
                    {fmtDateUS(a.created_at.slice(0, 10))} · <span style={{ color: C.textSub, textTransform: "capitalize" }}>{a.activity_type.replace(/_/g, " ")}</span>
                    {a.ar_invoice_id ? " · invoice-level" : " · account-level"}
                  </div>
                  {a.activity_type === "promise_to_pay" && a.promise_date && (
                    <div style={{ fontSize: 12, color: C.success }}>Promised {fmtCents(a.promise_amount_cents)} by {fmtDateUS(a.promise_date)}</div>
                  )}
                  <div style={{ fontSize: 13, color: C.text, marginTop: 2 }}>{a.outcome}</div>
                </div>
              ))}
            </div>
          )}

          {/* open invoices */}
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Open invoices</div>
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
            {loading ? (
              <div style={{ padding: 14, color: C.textMuted }}>Loading…</div>
            ) : invoices.length === 0 ? (
              <div style={{ padding: 14, color: C.textMuted }}>No open invoices.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={th}>Invoice</th><th style={th}>Date</th><th style={th}>Due</th>
                  <th style={{ ...th, textAlign: "right" }}>DPD</th><th style={th}>Bucket</th>
                  <th style={{ ...th, textAlign: "right" }}>Open</th><th style={th}>Status</th>
                </tr></thead>
                <tbody>
                  {invoices.slice(0, 500).map((i) => (
                    <tr key={i.ar_invoice_id}>
                      <td style={td}><span style={blueLink}>#{i.invoice_number || "—"}</span></td>
                      <td style={{ ...td, color: C.textMuted }}>{fmtDateUS(i.invoice_date)}</td>
                      <td style={{ ...td, color: C.textMuted }}>{fmtDateUS(i.due_date)}</td>
                      <td style={{ ...tdNum, color: i.days_past_due > 90 ? C.danger : i.days_past_due > 0 ? C.warn : C.textMuted }}>{i.days_past_due}</td>
                      <td style={{ ...td, color: BUCKET_COLOR[i.age_bucket] }}>{i.age_bucket}</td>
                      <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(i.open_cents)}</td>
                      <td style={td}><StatusBadge status={i.collection_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {invoices.length > 500 && (
              <div style={{ padding: "8px 12px", fontSize: 11, color: C.textMuted }}>Showing first 500 of {invoices.length} open invoices.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
