// src/tanda/InternalCrmActivities.tsx
//
// Tangerine P8-3 — CRM Activities admin panel (M25, arch §3 + §4).
// Append-only activity log. Filters + add-modal for manual note/call/meeting.
// Rows are immutable; only the `is_hidden` flag can be toggled.
//
// Hits /api/internal/crm/activities, /api/internal/crm/activities/:id.

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
import DateRangePresets from "./components/DateRangePresets.tsx";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

// Universal column-visibility registry for this panel (operator ask #1).
const CRM_ACTIVITIES_TABLE_KEY = "tangerine:crmactivities:columns";
const CRM_ACTIVITY_COLUMNS: ColumnDef[] = [
  { key: "type",        label: "Type" },
  { key: "subject",     label: "Subject / Body" },
  { key: "customer",    label: "Customer" },
  { key: "opportunity", label: "Opportunity" },
  { key: "occurred",    label: "Occurred" },
  { key: "duration",    label: "Dur" },
];

type Activity = {
  id: string;
  entity_id: string;
  customer_id: string | null;
  opportunity_id: string | null;
  case_id: string | null;
  activity_type: string;
  subject: string;
  body: string | null;
  occurred_at: string;
  duration_minutes: number | null;
  external_email: string | null;
  payload: Record<string, unknown>;
  is_hidden: boolean;
  created_at: string;
  created_by_user_id: string | null;
};

type CustomerLite = { id: string; code: string | null; name: string };

type OpportunityLite = { id: string; opportunity_number: string; title: string };

const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
};

const ALL_TYPES = [
  "note", "call", "email_in", "email_out", "meeting",
  "task_done", "stage_change", "system",
] as const;
// Types the operator can pick when logging a manual activity. The trigger-only
// types (stage_change, task_done) are reserved for DB triggers.
const MANUAL_TYPES = ["note", "call", "email_in", "email_out", "meeting", "system"] as const;

const TYPE_COLOR: Record<string, { bg: string; color: string }> = {
  note:         { bg: "#374151", color: "#d1d5db" },
  call:         { bg: "#1e3a8a", color: "#93c5fd" },
  email_in:     { bg: "#064e3b", color: "#6ee7b7" },
  email_out:    { bg: "#0c4a6e", color: "#7dd3fc" },
  meeting:      { bg: "#78350f", color: "#fcd34d" },
  task_done:    { bg: "#064e3b", color: "#6ee7b7" },
  stage_change: { bg: "#581c87", color: "#d8b4fe" },
  system:       { bg: "#1f2937", color: "#cbd5e1" },
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13, verticalAlign: "top",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, color: C.textMuted, marginBottom: 4,
  textTransform: "uppercase", letterSpacing: 0.5,
};

function pill(palette: { bg: string; color: string }): React.CSSProperties {
  return {
    display: "inline-block", padding: "2px 8px", borderRadius: 10,
    background: palette.bg, color: palette.color, fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "2-digit", day: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export default function InternalCrmActivities() {
  const [rows, setRows] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [oppFilter, setOppFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [includeHidden, setIncludeHidden] = useState(false);

  const [addOpen, setAddOpen] = useState(false);

  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityLite[]>([]);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    CRM_ACTIVITIES_TABLE_KEY,
    CRM_ACTIVITY_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  // Sortable scalar columns only. subject (JSX), customer/opportunity (lookups)
  // and duration (formatted) stay non-sortable.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:crmactivities:sort",
    accessors: {
      type: (r) => r.activity_type,
      occurred: (r) => r.occurred_at,
    },
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (typeFilter)     params.set("activity_type", typeFilter);
      if (customerFilter) params.set("customer_id", customerFilter);
      if (oppFilter)      params.set("opportunity_id", oppFilter);
      if (fromDate)       params.set("from", fromDate);
      if (toDate)         params.set("to", toDate);
      if (includeHidden)  params.set("include_hidden", "true");
      params.set("limit", "500");
      const r = await fetch(`/api/internal/crm/activities?${params.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadCustomers() {
    try {
      const r = await fetch("/api/internal/customer-master?limit=5000");
      if (!r.ok) return;
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data?.rows ?? []);
      setCustomers(
        list.map((c: { id: string; code?: string | null; customer_code?: string | null; name: string }) => ({
          id: c.id,
          code: c.code ?? c.customer_code ?? null,
          name: c.name,
        })),
      );
    } catch { /* non-fatal */ }
  }

  async function loadOpps() {
    try {
      const r = await fetch("/api/internal/crm/opportunities?limit=500");
      if (!r.ok) return;
      const data = await r.json();
      const list = Array.isArray(data) ? data : [];
      setOpportunities(list.map((o: { id: string; opportunity_number: string; title: string }) => ({
        id: o.id, opportunity_number: o.opportunity_number, title: o.title,
      })));
    } catch { /* non-fatal */ }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { loadCustomers(); loadOpps(); }, []);
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, customerFilter, oppFilter, fromDate, toDate, includeHidden]);

  const customerById = useMemo(() => {
    const m = new Map<string, CustomerLite>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  const oppById = useMemo(() => {
    const m = new Map<string, OpportunityLite>();
    for (const o of opportunities) m.set(o.id, o);
    return m;
  }, [opportunities]);

  async function toggleHidden(a: Activity) {
    setErr(null);
    try {
      const r = await fetch(`/api/internal/crm/activities/${a.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_hidden: !a.is_hidden }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.text }}>
          Activities
        </h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Append-only CRM activity log (M25)
        </span>
        <div style={{ flex: 1 }} />
        <ExportButton
          rows={rows.map((r) => ({
            activity_type: r.activity_type,
            subject: r.subject,
            body: r.body,
            occurred_at: r.occurred_at,
            duration_minutes: r.duration_minutes,
            external_email: r.external_email,
            customer_id: r.customer_id,
            customer_name: r.customer_id ? (customerById.get(r.customer_id)?.name ?? null) : null,
            opportunity_id: r.opportunity_id,
            opportunity_number: r.opportunity_id ? (oppById.get(r.opportunity_id)?.opportunity_number ?? null) : null,
            is_hidden: r.is_hidden,
            created_at: r.created_at,
          })) as unknown as Array<Record<string, unknown>>}
          filename="crm-activities"
          sheetName="Activities"
          columns={[
            { key: "activity_type",     header: "Type" },
            { key: "subject",           header: "Subject" },
            { key: "body",              header: "Body" },
            { key: "occurred_at",       header: "Occurred",     format: "datetime" },
            { key: "duration_minutes",  header: "Duration (min)", format: "number" },
            { key: "external_email",    header: "External Email" },
            { key: "customer_name",     header: "Customer" },
            { key: "opportunity_number", header: "Opp #" },
            { key: "is_hidden",         header: "Hidden" },
            { key: "created_at",        header: "Created",      format: "datetime" },
          ]}
        />
        <button type="button" style={btnPrimary} onClick={() => setAddOpen(true)}>
          + Log activity
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ minWidth: 160 }}>
          <label style={labelStyle}>Type</label>
          <SearchableSelect
            value={typeFilter || null}
            onChange={(v) => setTypeFilter(v)}
            options={[
              { value: "", label: "All" },
              ...ALL_TYPES.map((t) => ({ value: t, label: t })),
            ]}
            placeholder="All"
            inputStyle={inputStyle}
          />
        </div>
        <div style={{ minWidth: 220 }}>
          <label style={labelStyle}>Customer</label>
          <SearchableSelect
            value={customerFilter || null}
            onChange={(v) => setCustomerFilter(v)}
            options={[
              { value: "", label: "All" },
              ...customers.map((c) => ({ value: c.id, label: (c.code ? `${c.code} — ` : "") + c.name })),
            ]}
            placeholder="All"
          />
        </div>
        <div style={{ minWidth: 260 }}>
          <label style={labelStyle}>Opportunity</label>
          <SearchableSelect
            value={oppFilter || null}
            onChange={(v) => setOppFilter(v)}
            options={[
              { value: "", label: "All" },
              ...opportunities.map((o) => ({ value: o.id, label: `${o.opportunity_number} — ${truncate(o.title, 40)}` })),
            ]}
            placeholder="All"
          />
        </div>
        <div style={{ minWidth: 140 }}>
          <label style={labelStyle}>From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ minWidth: 140 }}>
          <label style={labelStyle}>To</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ paddingTop: 18 }}>
          <DateRangePresets variant="dropdown"
            from={fromDate}
            to={toDate}
            onChange={(f, t) => { setFromDate(f); setToDate(t); }}
          />
        </div>
        <label style={{ color: C.textSub, fontSize: 12, display: "flex", alignItems: "center", gap: 6, paddingTop: 18 }}>
          <input type="checkbox" checked={includeHidden} onChange={(e) => setIncludeHidden(e.target.checked)} />
          Include hidden
        </label>
        <div style={{ paddingTop: 18 }}>
          <TablePrefsButton
            tableKey={CRM_ACTIVITIES_TABLE_KEY}
            columns={CRM_ACTIVITY_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
          />
        </div>
      </div>

      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}

      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`,
        borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)",
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("type")} />
              <th style={th} hidden={!isVisible("subject")}>Subject / Body</th>
              <th style={th} hidden={!isVisible("customer")}>Customer</th>
              <th style={th} hidden={!isVisible("opportunity")}>Opportunity</th>
              <SortableTh label="Occurred" sortKey="occurred" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("occurred")} />
              <th style={th} hidden={!isVisible("duration")}>Dur</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={7}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={7}>No activities match.</td></tr>
            )}
            {!loading && sorted.map((r) => {
              const palette = TYPE_COLOR[r.activity_type] || TYPE_COLOR.system;
              return (
                <tr key={r.id} style={{ opacity: r.is_hidden ? 0.55 : 1 }}>
                  <td style={td} hidden={!isVisible("type")}><span style={pill(palette)}>{r.activity_type}</span></td>
                  <td style={td} hidden={!isVisible("subject")}>
                    <div style={{ color: C.text, fontWeight: 500 }}>{r.subject}</div>
                    {r.body && (
                      <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>{truncate(r.body, 120)}</div>
                    )}
                    {r.external_email && (
                      <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>
                        from {r.external_email}
                      </div>
                    )}
                  </td>
                  <td style={td} hidden={!isVisible("customer")}>
                    {r.customer_id
                      ? (customerById.get(r.customer_id)
                          ? `${customerById.get(r.customer_id)!.code ?? ""} ${customerById.get(r.customer_id)!.name}`.trim()
                          : truncate(r.customer_id, 12))
                      : "—"}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }} hidden={!isVisible("opportunity")}>
                    {r.opportunity_id
                      ? (oppById.get(r.opportunity_id)?.opportunity_number ?? truncate(r.opportunity_id, 12))
                      : "—"}
                  </td>
                  <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!isVisible("occurred")}>{fmtDate(r.occurred_at)}</td>
                  <td style={{ ...td, fontFamily: "monospace", textAlign: "right" }} hidden={!isVisible("duration")}>
                    {r.duration_minutes != null ? `${r.duration_minutes}m` : "—"}
                  </td>
                  <td style={td}>
                    <button type="button" onClick={() => toggleHidden(r)} style={btnSecondary}>
                      {r.is_hidden ? "Unhide" : "Hide"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <CreateActivityModal
          customers={customers}
          opportunities={opportunities}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create modal
// ─────────────────────────────────────────────────────────────────────────────
function CreateActivityModal({ customers, opportunities, onClose, onCreated }: {
  customers: CustomerLite[];
  opportunities: OpportunityLite[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [activityType, setActivityType] = useState<string>("note");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [opportunityId, setOpportunityId] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [duration, setDuration] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!subject.trim()) { setErr("Subject is required."); return; }
    setSaving(true);
    setErr(null);
    try {
      const author = getCachedAuthUserId();
      const body_payload: Record<string, unknown> = {
        activity_type: activityType,
        subject,
        body: body || null,
        customer_id: customerId || null,
        opportunity_id: opportunityId || null,
        created_by_user_id: author || null,
      };
      if (occurredAt) body_payload.occurred_at = occurredAt;
      if (duration.trim() !== "") {
        const n = Math.round(Number(duration));
        if (!Number.isFinite(n) || n < 0) throw new Error("Duration must be a non-negative integer");
        body_payload.duration_minutes = n;
      }
      const r = await fetch("/api/internal/crm/activities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body_payload),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title="Log activity">
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Field label="Type">
          <SearchableSelect
            value={activityType || null}
            onChange={(v) => setActivityType(v)}
            options={MANUAL_TYPES.map((t) => ({ value: t, label: t }))}
            inputStyle={inputStyle}
          />
        </Field>
        <Field label="Occurred at">
          <input
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Duration (min)">
          <input
            type="number"
            min={0}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            style={inputStyle}
            placeholder="optional"
          />
        </Field>
      </div>
      <Field label="Subject *">
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} style={inputStyle} />
      </Field>
      <Field label="Body">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
        />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Customer">
          <SearchableSelect
            value={customerId || null}
            onChange={(v) => setCustomerId(v)}
            options={[
              { value: "", label: "(select)" },
              ...customers.map((c) => ({ value: c.id, label: (c.code ? `${c.code} — ` : "") + c.name })),
            ]}
            placeholder="(select)"
          />
        </Field>
        <Field label="Opportunity">
          <SearchableSelect
            value={opportunityId || null}
            onChange={(v) => setOpportunityId(v)}
            options={[
              { value: "", label: "(select)" },
              ...opportunities.map((o) => ({ value: o.id, label: `${o.opportunity_number} — ${truncate(o.title, 40)}` })),
            ]}
            placeholder="(select)"
          />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={create} disabled={saving} style={btnPrimary}>
          {saving ? "Logging…" : "Log activity"}
        </button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell
// ─────────────────────────────────────────────────────────────────────────────
function Modal({ title, children, onClose }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`,
          borderRadius: 10, width: "min(800px, 95vw)", maxHeight: "90vh",
          overflowY: "auto", boxSizing: "border-box", padding: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>{title}</h2>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={{ ...btnSecondary, padding: "4px 8px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}
