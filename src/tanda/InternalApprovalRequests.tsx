// src/tanda/InternalApprovalRequests.tsx
//
// Tangerine P2 Chunk 2 — Approval requests inbox.
// Lists pending/decided requests. Decide modal lets a user with the right
// role mark a step approve/reject/request_changes. Cancel for owner/admin.

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import SearchableSelect from "./components/SearchableSelect";
import { useEmployeeOptions } from "./hooks/useEmployeeOptions";

// Universal column-visibility registry for this panel (operator ask #1).
const APPROVAL_REQ_TABLE_KEY = "tangerine:approvalrequests:columns";
const APPROVAL_REQ_COLUMNS: ColumnDef[] = [
  { key: "kind",         label: "Kind" },
  { key: "context",      label: "Context" },
  { key: "amount",       label: "Amount" },
  { key: "current_step", label: "Current step" },
  { key: "status",       label: "Status" },
  { key: "created",      label: "Created" },
];

type Step = {
  id: string;
  step_order: number;
  mode: "any" | "all";
  role_required: string;
  fulfilled_at: string | null;
  fulfilled_by_user_id: string | null;
  notes: string | null;
};

type Request = {
  id: string;
  entity_id: string;
  kind: string;
  context_table: string;
  context_id: string;
  requested_amount_cents: number | null;
  currency: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  final_decided_at: string | null;
  expires_at: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  created_by_user_id: string | null;
  steps: Step[];
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const STATUS_COLOR: Record<string, string> = {
  pending: C.warn, approved: C.success, rejected: C.danger,
  cancelled: C.textMuted, expired: C.textMuted,
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

function formatCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function currentStep(req: Request): Step | null {
  const sorted = [...(req.steps || [])].sort((a, b) => a.step_order - b.step_order);
  return sorted.find((s) => !s.fulfilled_at) || null;
}

export default function InternalApprovalRequests() {
  const [rows, setRows] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Request["status"]>("pending");
  const [kindFilter, setKindFilter] = useState("");
  const [deciding, setDeciding] = useState<Request | null>(null);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    APPROVAL_REQ_TABLE_KEY,
    APPROVAL_REQ_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  // context (composite id) and current_step (computed) stay non-sortable.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:approvalrequests:sort",
    accessors: {
      amount: (r) => r.requested_amount_cents,
      created: (r) => r.created_at,
    },
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("status", statusFilter);
      if (kindFilter) params.set("kind", kindFilter);
      const r = await fetch(`/api/internal/approval-requests?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [statusFilter, kindFilter]);

  async function cancelRequest(req: Request) {
    // Use the cached MS-sign-in identity — never prompt for a raw uuid. If the
    // operator isn't signed in, surface a sign-in error instead of a uuid box.
    const actor = getCachedAuthUserId();
    if (!actor) { setErr("Sign in with Microsoft to cancel an approval request."); return; }
    const r = await fetch(`/api/internal/approval-requests/${req.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_user_id: actor.trim() }),
    });
    if (!r.ok) {
      setErr((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return;
    }
    void load();
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Approval requests</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Pending requests block their underlying posts. Approve to unblock.
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        <div style={{ width: 160 }}>
          <SearchableSelect
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as Request["status"])}
            options={[
              { value: "pending", label: "Pending" },
              { value: "approved", label: "Approved" },
              { value: "rejected", label: "Rejected" },
              { value: "cancelled", label: "Cancelled" },
              { value: "expired", label: "Expired" },
            ]}
            inputStyle={inputStyle}
          />
        </div>
        <input
          style={{ ...inputStyle, width: 200 }}
          placeholder="Filter by kind"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        />
        <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          <ExportButton
            rows={rows as unknown as Array<Record<string, unknown>>}
            filename="approval-requests"
            sheetName="Approval Requests"
            columns={[
              { key: "created_at",              header: "Created",       format: "datetime" },
              { key: "kind",                    header: "Kind" },
              { key: "context_table",           header: "Context Table" },
              { key: "context_id",              header: "Context ID" },
              { key: "requested_amount_cents",  header: "Amount",        format: "currency_cents" },
              { key: "currency",                header: "Currency" },
              { key: "status",                  header: "Status" },
              { key: "final_decided_at",        header: "Decided At",    format: "datetime" },
              { key: "expires_at",              header: "Expires At",    format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
          <TablePrefsButton
            tableKey={APPROVAL_REQ_TABLE_KEY}
            columns={APPROVAL_REQ_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
          />
        </div>
      </div>

      {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortableTh label="Kind" sortKey="kind" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("kind")} />
              <th style={th} hidden={!isVisible("context")}>Context</th>
              <SortableTh label="Amount" sortKey="amount" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("amount")} />
              <th style={th} hidden={!isVisible("current_step")}>Current step</th>
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("status")} />
              <SortableTh label="Created" sortKey="created" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("created")} />
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={7}>Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={7}>
                <span style={{ color: C.textMuted }}>No requests in this state.</span>
              </td></tr>
            )}
            {sorted.map((r) => {
              const cur = currentStep(r);
              return (
                <tr key={r.id}>
                  <td style={{ ...td, fontFamily: "monospace" }} hidden={!isVisible("kind")}>{r.kind}</td>
                  <td style={{ ...td, fontSize: 11, color: C.textSub }} hidden={!isVisible("context")}>
                    {r.context_table || "—"}
                  </td>
                  <td style={td} hidden={!isVisible("amount")}>{formatCents(r.requested_amount_cents)}</td>
                  <td style={td} hidden={!isVisible("current_step")}>
                    {cur ? `${cur.step_order}. ${cur.mode}/${cur.role_required}` : "—"}
                  </td>
                  <td style={{ ...td, color: STATUS_COLOR[r.status] }} hidden={!isVisible("status")}>{r.status}</td>
                  <td style={{ ...td, color: C.textSub, fontSize: 12 }} hidden={!isVisible("created")}>
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td style={td}>
                    {r.status === "pending" && cur && (
                      <>
                        <button style={btnPrimary} onClick={() => setDeciding(r)}>Decide</button>
                        &nbsp;
                        <button style={btnDanger} onClick={() => void cancelRequest(r)}>Cancel</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {deciding && (
        <DecideModal
          request={deciding}
          onCancel={() => setDeciding(null)}
          onSaved={() => { setDeciding(null); void load(); }}
        />
      )}
    </div>
  );
}

function DecideModal({ request, onCancel, onSaved }: {
  request: Request;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const step = currentStep(request);
  const [decision, setDecision] = useState<"approve" | "reject" | "request_changes">("approve");
  const [notes, setNotes] = useState("");
  // Pre-fill from the auth bridge cache so the operator never sees or types a
  // uuid. The signed-in user is the default actor; an "act as another user"
  // toggle reveals an EMPLOYEE picker (never a raw uuid box).
  const [actor, setActor] = useState(() => getCachedAuthUserId());
  const [actAsOther, setActAsOther] = useState(false);
  const { employees, options: employeeOptions } = useEmployeeOptions();
  const signedInLabel = useMemo(() => {
    const cached = getCachedAuthUserId();
    const me = employees.find((e) => e.id === cached);
    if (me) {
      const name = [me.first_name, me.last_name].filter(Boolean).join(" ").trim();
      return (me.code && name) ? `${me.code} — ${name}` : (name || me.email || "Signed-in user");
    }
    return cached ? "Signed-in user" : "Not signed in";
  }, [employees]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setErr(null);
    if (!step) { setErr("No current step"); return; }
    if (!actor) { setErr("No signed-in user — pick who you're acting as."); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/internal/approval-requests/${request.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step_id: step.id, decision, notes: notes || undefined, actor_user_id: actor,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
        padding: 24, width: "min(540px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
      }}>
        <h2 style={{ margin: "0 0 16px 0", fontSize: 18 }}>Decide step</h2>

        <div style={{ marginBottom: 12, fontSize: 13, color: C.textSub }}>
          <div>Request: <strong style={{ color: C.text }}>{request.kind}</strong></div>
          <div>Context: {request.context_table}#{request.context_id.slice(0, 12)}</div>
          {step && (
            <div>Step {step.step_order} — mode <code>{step.mode}</code>, role required <code>{step.role_required}</code></div>
          )}
        </div>

        <Field label="Decision">
          <SearchableSelect
            value={decision}
            onChange={(v) => setDecision(v as typeof decision)}
            options={[
              { value: "approve", label: "✓ Approve" },
              { value: "reject", label: "✗ Reject (terminal)" },
              { value: "request_changes", label: "↻ Request changes (logged, no status change)" },
            ]}
            inputStyle={inputStyle}
          />
        </Field>

        <Field label="Notes (optional)">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <Field label="Acting as">
          {!actAsOther ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: C.text, fontSize: 13 }}>{signedInLabel}</span>
              <button
                type="button"
                style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}
                onClick={() => setActAsOther(true)}
              >
                Act as another user
              </button>
            </div>
          ) : (
            <div>
              <SearchableSelect
                value={actor || null}
                onChange={(v) => setActor(v || "")}
                options={employeeOptions}
                placeholder="Pick the employee you're acting as…"
                emptyText="No matching employees"
              />
              <button
                type="button"
                style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12, marginTop: 6 }}
                onClick={() => { setActAsOther(false); setActor(getCachedAuthUserId()); }}
              >
                Use my own sign-in
              </button>
            </div>
          )}
        </Field>

        {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginTop: 8, fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btnSecondary} onClick={onCancel} disabled={saving}>Cancel</button>
          <button style={btnPrimary} onClick={() => void submit()} disabled={saving}>
            {saving ? "Saving…" : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", marginBottom: 4, color: C.textSub, fontSize: 12, fontWeight: 600 }}>
        {label}
      </label>
      {children}
    </div>
  );
}
