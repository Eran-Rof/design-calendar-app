// src/tanda/InternalCrmOpportunities.tsx
//
// Tangerine P8-3 — CRM Opportunities admin panel (M25, arch §3 + §4).
// List + filters + detail/edit modal (with inline activity log + stage-change
// dropdown calling POST /:id/stage) + create-new modal.
//
// Hits /api/internal/crm/opportunities, /api/internal/crm/opportunities/:id,
// /api/internal/crm/opportunities/:id/stage.

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
import { confirmDialog } from "../shared/ui/warn";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useEmployeeOptions } from "./hooks/useEmployeeOptions";
import { fmtDateDisplay } from "../utils/tandaTypes";

// Universal column-visibility registry for this panel (operator ask #1).
const CRM_OPPS_TABLE_KEY = "tangerine:crmopportunities:columns";
const CRM_OPP_COLUMNS: ColumnDef[] = [
  { key: "opp_number",     label: "Opp #" },
  { key: "title",          label: "Title" },
  { key: "customer",       label: "Customer" },
  { key: "stage",          label: "Stage" },
  { key: "probability",    label: "Prob %" },
  { key: "expected",       label: "Expected" },
  { key: "expected_close", label: "Expected Close" },
  { key: "owner",          label: "Owner" },
  { key: "created",        label: "Created" },
];

type Stage = "new" | "qualified" | "proposal" | "won" | "lost";

type Opportunity = {
  id: string;
  entity_id: string;
  customer_id: string | null;
  opportunity_number: string;
  title: string;
  stage: Stage;
  stage_changed_at: string;
  expected_cents: number | null;
  probability_pct: number;
  expected_close_date: string | null;
  actual_close_date: string | null;
  loss_reason: string | null;
  owner_user_id: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  customer?: { id: string; code: string | null; name: string } | null;
};

type Activity = {
  id: string;
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

type OpenTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  assignee_user_id: string | null;
  created_at: string;
};

type OpportunityDetail = Opportunity & {
  activities: Activity[];
  open_tasks: OpenTask[];
};

type CustomerLite = { id: string; code: string | null; name: string };

const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
  primaryDim: "#1d4ed8",
};

const STAGE_VALUES: Stage[] = ["new", "qualified", "proposal", "won", "lost"];

const STAGE_COLOR: Record<Stage, { bg: string; color: string }> = {
  new:        { bg: "#374151", color: "#d1d5db" },
  qualified:  { bg: "#1e3a8a", color: "#93c5fd" },
  proposal:   { bg: "#78350f", color: "#fcd34d" },
  won:        { bg: "#064e3b", color: "#6ee7b7" },
  lost:       { bg: "#7f1d1d", color: "#fca5a5" },
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

const fmtDateOnly = fmtDateDisplay;

function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export default function InternalCrmOpportunities() {
  const [rows, setRows] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Employee picker options + id→name map (no raw user UUIDs anywhere).
  const { employees, options: employeeOptions } = useEmployeeOptions();
  const ownerName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of employees) {
      const name = [e.first_name, e.last_name].filter(Boolean).join(" ").trim();
      m[e.id] = (e.code && name) ? `${e.code} — ${name}` : (name || e.code || e.email || e.id);
    }
    return m;
  }, [employees]);

  const [stageFilter, setStageFilter] = useState<string>("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [q, setQ] = useState<string>("");

  const [detailId, setDetailId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [customers, setCustomers] = useState<CustomerLite[]>([]);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    CRM_OPPS_TABLE_KEY,
    CRM_OPP_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (stageFilter)    params.set("stage", stageFilter);
      if (ownerFilter)    params.set("owner_user_id", ownerFilter);
      if (customerFilter) params.set("customer_id", customerFilter);
      if (q.trim())       params.set("q", q.trim());
      params.set("limit", "500");
      const r = await fetch(`/api/internal/crm/opportunities?${params.toString()}`);
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
      const list = Array.isArray(data)
        ? data
        : (data?.rows && Array.isArray(data.rows) ? data.rows : []);
      setCustomers(
        list.map((c: { id: string; code?: string | null; customer_code?: string | null; name: string }) => ({
          id: c.id,
          code: c.code ?? c.customer_code ?? null,
          name: c.name,
        })),
      );
    } catch { /* non-fatal */ }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { loadCustomers(); }, []);

  // Debounced reload when filters change.
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageFilter, ownerFilter, customerFilter, q]);

  const filterBarStyle: React.CSSProperties = {
    display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
    marginBottom: 14,
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.text }}>
          Opportunities
        </h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Pipeline (M25)
        </span>
        <div style={{ flex: 1 }} />
        <ExportButton
          rows={rows.map((r) => ({
            opportunity_number: r.opportunity_number,
            title: r.title,
            stage: r.stage,
            probability_pct: r.probability_pct,
            expected_cents: r.expected_cents,
            expected_close_date: r.expected_close_date,
            customer_code: r.customer?.code ?? null,
            customer_name: r.customer?.name ?? null,
            owner_user_id: r.owner_user_id,
            created_at: r.created_at,
            stage_changed_at: r.stage_changed_at,
          })) as unknown as Array<Record<string, unknown>>}
          filename="crm-opportunities"
          sheetName="Opportunities"
          columns={[
            { key: "opportunity_number",   header: "Opp #" },
            { key: "title",                header: "Title" },
            { key: "stage",                header: "Stage" },
            { key: "probability_pct",      header: "Probability %", format: "number" },
            { key: "expected_cents",       header: "Expected",      format: "currency_cents" },
            { key: "expected_close_date",  header: "Expected Close", format: "date" },
            { key: "customer_code",        header: "Customer Code" },
            { key: "customer_name",        header: "Customer" },
            { key: "owner_user_id",        header: "Owner" },
            { key: "created_at",           header: "Created",       format: "datetime" },
            { key: "stage_changed_at",     header: "Stage Changed", format: "datetime" },
          ]}
        />
        <button type="button" style={btnPrimary} onClick={() => setAddOpen(true)}>
          + New opportunity
        </button>
      </div>

      <div style={filterBarStyle}>
        <div style={{ minWidth: 140 }}>
          <Select label="Stage" value={stageFilter} onChange={setStageFilter} options={[...STAGE_VALUES]} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label style={labelStyle}>Owner</label>
          <SearchableSelect
            value={ownerFilter || null}
            onChange={(v) => setOwnerFilter(v || "")}
            options={[{ value: "", label: "All" }, ...employeeOptions]}
            placeholder="All"
            emptyText="No matching employees"
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
        <div style={{ flex: 1, minWidth: 220 }}>
          <label style={labelStyle}>Search title</label>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. spring buy"
            style={inputStyle}
          />
        </div>
        <div style={{ paddingTop: 18 }}>
          <TablePrefsButton
            tableKey={CRM_OPPS_TABLE_KEY}
            columns={CRM_OPP_COLUMNS}
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
        }}>
          {err}
        </div>
      )}

      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`,
        borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)",
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th} hidden={!isVisible("opp_number")}>Opp #</th>
              <th style={th} hidden={!isVisible("title")}>Title</th>
              <th style={th} hidden={!isVisible("customer")}>Customer</th>
              <th style={th} hidden={!isVisible("stage")}>Stage</th>
              <th style={th} hidden={!isVisible("probability")}>Prob %</th>
              <th style={th} hidden={!isVisible("expected")}>Expected</th>
              <th style={th} hidden={!isVisible("expected_close")}>Expected Close</th>
              <th style={th} hidden={!isVisible("owner")}>Owner</th>
              <th style={th} hidden={!isVisible("created")}>Created</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={9}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={9}>No opportunities match.</td></tr>
            )}
            {!loading && rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setDetailId(r.id)}
                style={{ cursor: "pointer" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "#0b1220"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
              >
                <td style={{ ...td, fontFamily: "monospace", fontSize: 12, color: C.textSub }} hidden={!isVisible("opp_number")}>{r.opportunity_number}</td>
                <td style={td} hidden={!isVisible("title")}>{truncate(r.title, 60)}</td>
                <td style={td} hidden={!isVisible("customer")}>{r.customer ? `${r.customer.code ?? ""} ${r.customer.name}`.trim() : "—"}</td>
                <td style={td} hidden={!isVisible("stage")}><span style={pill(STAGE_COLOR[r.stage])}>{r.stage}</span></td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }} hidden={!isVisible("probability")}>{r.probability_pct}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }} hidden={!isVisible("expected")}>{fmtMoney(r.expected_cents)}</td>
                <td style={{ ...td, fontSize: 12 }} hidden={!isVisible("expected_close")}>{fmtDateOnly(r.expected_close_date)}</td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!isVisible("owner")}>
                  {r.owner_user_id ? (ownerName[r.owner_user_id] || truncate(r.owner_user_id, 12)) : "—"}
                </td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!isVisible("created")}>{fmtDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detailId && (
        <OpportunityDetailModal
          id={detailId}
          onClose={() => { setDetailId(null); load(); }}
          customers={customers}
        />
      )}
      {addOpen && (
        <CreateOpportunityModal
          customers={customers}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); load(); }}
        />
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, color: C.textMuted, marginBottom: 4,
  textTransform: "uppercase", letterSpacing: 0.5,
};

function Select({ label, value, onChange, options, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <SearchableSelect
        value={value || null}
        onChange={(v) => onChange(v)}
        options={[
          { value: "", label: placeholder || "All" },
          ...options.map((o) => ({ value: o, label: o.replace("_", " ") })),
        ]}
        placeholder={placeholder || "All"}
        inputStyle={inputStyle}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail modal — view + edit opp header + stage-change dropdown + activity log
// ─────────────────────────────────────────────────────────────────────────────
function OpportunityDetailModal({ id, onClose, customers }: {
  id: string;
  onClose: () => void;
  customers: CustomerLite[];
}) {
  const [data, setData] = useState<OpportunityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { options: employeeOptions } = useEmployeeOptions();

  // Local pending edits — applied on save.
  const [title, setTitle] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [owner, setOwner] = useState("");
  const [expectedDollars, setExpectedDollars] = useState("");
  const [probability, setProbability] = useState<number>(50);
  const [expectedClose, setExpectedClose] = useState("");
  const [actualClose, setActualClose] = useState("");
  const [lossReason, setLossReason] = useState("");
  const [description, setDescription] = useState("");

  // Stage change controls (kept separate — uses RPC endpoint).
  const [pendingStage, setPendingStage] = useState<Stage | "">("");
  const [stageReason, setStageReason] = useState("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/crm/opportunities/${id}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const d: OpportunityDetail = await r.json();
      setData(d);
      setTitle(d.title);
      setCustomerId(d.customer_id || "");
      setOwner(d.owner_user_id || "");
      setExpectedDollars(d.expected_cents == null ? "" : (d.expected_cents / 100).toFixed(2));
      setProbability(d.probability_pct);
      setExpectedClose(d.expected_close_date || "");
      setActualClose(d.actual_close_date || "");
      setLossReason(d.loss_reason || "");
      setDescription(d.description || "");
      setPendingStage("");
      setStageReason("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const customerById = useMemo(() => {
    const m = new Map<string, CustomerLite>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  async function save() {
    if (!data) return;
    setSaving(true);
    setErr(null);
    try {
      const actor = getCachedAuthUserId();
      const patch: Record<string, string | number | null> = {};
      if (title !== data.title) patch.title = title;
      if ((customerId || null) !== (data.customer_id || null)) patch.customer_id = customerId || null;
      if ((owner || null) !== (data.owner_user_id || null)) patch.owner_user_id = owner || null;

      const parsedExpectedCents = expectedDollars.trim() === ""
        ? null
        : Math.round(Number(expectedDollars) * 100);
      if (parsedExpectedCents !== data.expected_cents) {
        if (parsedExpectedCents != null && (!Number.isFinite(parsedExpectedCents) || parsedExpectedCents < 0)) {
          throw new Error("Expected $ must be ≥ 0");
        }
        patch.expected_cents = parsedExpectedCents;
      }

      if (probability !== data.probability_pct) patch.probability_pct = probability;
      if ((expectedClose || null) !== (data.expected_close_date || null)) patch.expected_close_date = expectedClose || null;
      if ((actualClose || null) !== (data.actual_close_date || null)) patch.actual_close_date = actualClose || null;
      if ((lossReason || null) !== (data.loss_reason || null)) patch.loss_reason = lossReason || null;
      if ((description || null) !== (data.description || null)) patch.description = description || null;

      if (Object.keys(patch).length === 0) { setSaving(false); return; }

      const body: Record<string, unknown> = { ...patch };
      if (actor) body.actor_user_id = actor;

      const r = await fetch(`/api/internal/crm/opportunities/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function changeStage() {
    if (!data || !pendingStage || pendingStage === data.stage) return;
    setSaving(true);
    setErr(null);
    try {
      const actor = getCachedAuthUserId();
      const r = await fetch(`/api/internal/crm/opportunities/${id}/stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stage: pendingStage,
          reason: stageReason || null,
          actor_user_id: actor || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteOpp() {
    if (!data) return;
    if (!(await confirmDialog(`Delete opportunity ${data.opportunity_number}? Activities and tasks will be unlinked but preserved for audit.`))) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/crm/opportunities/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title={data ? `${data.opportunity_number} — ${truncate(data.title, 50)}` : "Loading…"}>
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      {data && (
        <>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 14,
          }}>
            <Field label="Current stage">
              <div style={{ ...inputStyle, padding: "6px 10px" }}>
                <span style={pill(STAGE_COLOR[data.stage])}>{data.stage}</span>
              </div>
            </Field>
            <Field label="Probability %">
              <input
                type="number"
                min={0}
                max={100}
                value={probability}
                onChange={(e) => setProbability(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
                style={inputStyle}
              />
            </Field>
            <Field label="Expected $">
              <input
                type="number"
                step="0.01"
                value={expectedDollars}
                onChange={(e) => setExpectedDollars(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Owner">
              <SearchableSelect
                value={owner || null}
                onChange={(v) => setOwner(v || "")}
                options={[{ value: "", label: "Unassigned" }, ...employeeOptions]}
                placeholder="Unassigned"
                emptyText="No matching employees"
              />
            </Field>
          </div>

          <Field label="Title">
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
            <Field label="Customer">
              <SearchableSelect
                value={customerId || null}
                onChange={(v) => setCustomerId(v)}
                options={[
                  { value: "", label: "(select)" },
                  ...customers.map((c) => ({
                    value: c.id,
                    label: (c.code ? `${c.code} — ` : "") + c.name,
                  })),
                  ...(customerId && !customerById.has(customerId)
                    ? [{ value: customerId, label: customerId }]
                    : []),
                ]}
                placeholder="(select)"
              />
            </Field>
            <Field label="Expected close">
              <input
                type="date"
                value={expectedClose}
                onChange={(e) => setExpectedClose(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Actual close">
              <input
                type="date"
                value={actualClose}
                onChange={(e) => setActualClose(e.target.value)}
                style={inputStyle}
              />
            </Field>
          </div>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
            />
          </Field>
          {(data.stage === "lost" || lossReason) && (
            <Field label="Loss reason">
              <input
                type="text"
                value={lossReason}
                onChange={(e) => setLossReason(e.target.value)}
                style={inputStyle}
              />
            </Field>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
            <button type="button" onClick={save} disabled={saving} style={btnPrimary}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={onClose} style={btnSecondary}>Close</button>
            <button type="button" onClick={deleteOpp} disabled={saving} style={{
              ...btnSecondary, color: "#fca5a5", borderColor: "#7f1d1d",
            }}>
              Delete
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ color: C.textMuted, fontSize: 11 }}>
              Created {fmtDate(data.created_at)} · Updated {fmtDate(data.updated_at)}
            </span>
          </div>

          <hr style={{ border: 0, borderTop: `1px solid ${C.cardBdr}`, margin: "20px 0 14px" }} />

          <h3 style={{ margin: "0 0 8px", fontSize: 13, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
            Change stage
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 12, alignItems: "end" }}>
            <Field label="New stage">
              <SearchableSelect
                value={pendingStage}
                onChange={(v) => setPendingStage(v as Stage | "")}
                options={[
                  { value: "", label: "— select —" },
                  ...STAGE_VALUES.filter((s) => s !== data.stage).map((s) => ({ value: s, label: s })),
                ]}
                placeholder="— select —"
                inputStyle={inputStyle}
              />
            </Field>
            <Field label="Reason (optional)">
              <input
                type="text"
                value={stageReason}
                onChange={(e) => setStageReason(e.target.value)}
                style={inputStyle}
                placeholder="e.g. customer signed proposal"
              />
            </Field>
            <button
              type="button"
              onClick={changeStage}
              disabled={saving || !pendingStage || pendingStage === data.stage}
              style={{ ...btnPrimary, marginBottom: 10 }}
            >
              {saving ? "Changing…" : "Change stage"}
            </button>
          </div>

          <hr style={{ border: 0, borderTop: `1px solid ${C.cardBdr}`, margin: "20px 0 14px" }} />

          <h3 style={{ margin: "0 0 8px", fontSize: 13, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
            Activity log (latest {data.activities.length})
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14, maxHeight: 320, overflowY: "auto" }}>
            {data.activities.length === 0 && (
              <div style={{ color: C.textMuted, fontSize: 12 }}>No activities yet.</div>
            )}
            {data.activities.map((a) => (
              <div key={a.id} style={{
                background: "#0b1220",
                border: `1px solid ${C.cardBdr}`,
                borderRadius: 6, padding: "8px 10px",
                opacity: a.is_hidden ? 0.5 : 1,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: C.textMuted }}>
                    <span style={{
                      display: "inline-block", padding: "1px 6px", borderRadius: 8,
                      background: "#1f2937", color: "#cbd5e1", fontSize: 10, fontWeight: 600,
                      textTransform: "uppercase", letterSpacing: 0.5, marginRight: 6,
                    }}>{a.activity_type}</span>
                    {fmtDate(a.occurred_at)}
                    {a.duration_minutes != null && ` · ${a.duration_minutes} min`}
                    {a.external_email && ` · ${a.external_email}`}
                  </span>
                  {a.is_hidden && <span style={{ color: C.textMuted, fontSize: 10 }}>hidden</span>}
                </div>
                <div style={{ color: C.text, fontSize: 13, fontWeight: 500 }}>{a.subject}</div>
                {a.body && (
                  <div style={{ color: C.textSub, fontSize: 12, marginTop: 4, whiteSpace: "pre-wrap" }}>{a.body}</div>
                )}
              </div>
            ))}
          </div>

          {data.open_tasks.length > 0 && (
            <>
              <h3 style={{ margin: "0 0 8px", fontSize: 13, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
                Open tasks ({data.open_tasks.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {data.open_tasks.map((t) => (
                  <div key={t.id} style={{
                    background: "#0b1220", border: `1px solid ${C.cardBdr}`,
                    borderRadius: 6, padding: "6px 10px",
                    display: "flex", gap: 10, alignItems: "center", fontSize: 12,
                  }}>
                    <span style={{ color: C.text, flex: 1 }}>{t.title}</span>
                    <span style={{ color: C.textMuted }}>{t.priority}</span>
                    <span style={{ color: C.textMuted }}>{fmtDateOnly(t.due_date)}</span>
                    <span style={{ color: C.textMuted }}>{t.status}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create modal
// ─────────────────────────────────────────────────────────────────────────────
function CreateOpportunityModal({ customers, onClose, onCreated }: {
  customers: CustomerLite[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { options: employeeOptions } = useEmployeeOptions();
  const [title, setTitle] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [owner, setOwner] = useState("");
  const [stage, setStage] = useState<Stage>("new");
  const [expectedDollars, setExpectedDollars] = useState("");
  const [probability, setProbability] = useState<number>(50);
  const [expectedClose, setExpectedClose] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!title.trim()) {
      setErr("Title is required.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const author = getCachedAuthUserId();
      const expected_cents = expectedDollars.trim() === ""
        ? null
        : Math.round(Number(expectedDollars) * 100);
      if (expected_cents != null && (!Number.isFinite(expected_cents) || expected_cents < 0)) {
        throw new Error("Expected $ must be ≥ 0");
      }
      const r = await fetch("/api/internal/crm/opportunities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          customer_id: customerId || null,
          owner_user_id: owner || null,
          stage,
          probability_pct: probability,
          expected_cents,
          expected_close_date: expectedClose || null,
          description: description || null,
          created_by_user_id: author || null,
        }),
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
    <Modal onClose={onClose} title="New opportunity">
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      <Field label="Title *">
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
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
        <Field label="Stage">
          <SearchableSelect
            value={stage}
            onChange={(v) => setStage(v as Stage)}
            options={STAGE_VALUES.map((s) => ({ value: s, label: s }))}
            inputStyle={inputStyle}
          />
        </Field>
        <Field label="Owner">
          <SearchableSelect
            value={owner || null}
            onChange={(v) => setOwner(v || "")}
            options={[{ value: "", label: "Unassigned" }, ...employeeOptions]}
            placeholder="Unassigned"
            emptyText="No matching employees"
          />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Field label="Probability %">
          <input
            type="number"
            min={0}
            max={100}
            value={probability}
            onChange={(e) => setProbability(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
            style={inputStyle}
          />
        </Field>
        <Field label="Expected $">
          <input
            type="number"
            step="0.01"
            value={expectedDollars}
            onChange={(e) => setExpectedDollars(e.target.value)}
            style={inputStyle}
            placeholder="0.00"
          />
        </Field>
        <Field label="Expected close">
          <input type="date" value={expectedClose} onChange={(e) => setExpectedClose(e.target.value)} style={inputStyle} />
        </Field>
      </div>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
        />
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={create} disabled={saving} style={btnPrimary}>
          {saving ? "Creating…" : "Create opportunity"}
        </button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic modal shell
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
          borderRadius: 10, width: "min(900px, 95vw)", maxHeight: "90vh",
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
