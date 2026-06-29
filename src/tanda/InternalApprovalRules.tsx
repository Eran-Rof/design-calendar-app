// src/tanda/InternalApprovalRules.tsx
//
// Tangerine P2 Chunk 2 — Approval rules admin panel.
// CRUD over approval_rules. Match + Steps are edited as raw JSON so the
// operator has full vocabulary access (per arch §12.4 — structured form
// for the 3 MVP rule shapes is a future polish).

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import SearchableSelect from "./components/SearchableSelect";

const TABLE_KEY = "tanda.approval_rules";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "kind", label: "Kind" },
  { key: "name", label: "Name" },
  { key: "match", label: "Match" },
  { key: "steps", label: "Steps" },
  { key: "active", label: "Active" },
  { key: "actions", label: "Actions" },
];

type Rule = {
  id: string;
  kind: string;
  name: string;
  match: Record<string, unknown>;
  steps: Array<{ step_order: number; mode: "any" | "all"; role_required: string }>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const KNOWN_KINDS = ["ap_invoice", "je_post", "po_release", "customer_credit_limit"];
const ROLES = ["admin", "accountant", "staff", "readonly"];

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

export default function InternalApprovalRules() {
  const [rows, setRows] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  const { getRowProps } = useRowClickEdit<Rule>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit rule ${r.name}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (kindFilter) params.set("kind", kindFilter);
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/approval-rules?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [kindFilter, includeInactive]);

  async function toggleActive(rule: Rule) {
    const r = await fetch(`/api/internal/approval-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: !rule.is_active }),
    });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return; }
    void load();
  }

  async function deleteRule(id: string) {
    if (!(await confirmDialog("Delete this rule? Existing requests are unaffected; only future matches stop."))) return;
    const r = await fetch(`/api/internal/approval-rules/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) {
      setErr((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return;
    }
    void load();
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Approval rules</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          JSONB-spec rules that gate posting flows. Empty list = nothing is gated.
        </span>
        <button style={{ ...btnPrimary, marginLeft: "auto" }} onClick={() => setAddOpen(true)}>+ Add rule</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        <div style={{ width: 200 }}>
          <SearchableSelect
            value={kindFilter || null}
            onChange={(v) => setKindFilter(v)}
            options={[
              { value: "", label: "All kinds" },
              ...KNOWN_KINDS.map((k) => ({ value: k, label: k })),
            ]}
            placeholder="All kinds"
            inputStyle={inputStyle}
          />
        </div>
        <label style={{ color: C.textSub, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Include inactive
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <TablePrefsButton
            tableKey={TABLE_KEY}
            columns={ALL_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
            onSetAll={setAllVisible}
          />
          <ExportButton
            rows={rows as unknown as Array<Record<string, unknown>>}
            filename="approval-rules"
            sheetName="Approval Rules"
            columns={[
              { key: "kind",       header: "Kind" },
              { key: "name",       header: "Name" },
              { key: "match",      header: "Match" },
              { key: "steps",      header: "Steps" },
              { key: "is_active",  header: "Active" },
              { key: "created_at", header: "Created",  format: "datetime" },
              { key: "updated_at", header: "Updated",  format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th} hidden={!visibleColumns.has("kind")}>Kind</th>
              <th style={th} hidden={!visibleColumns.has("name")}>Name</th>
              <th style={th} hidden={!visibleColumns.has("match")}>Match</th>
              <th style={th} hidden={!visibleColumns.has("steps")}>Steps</th>
              <th style={th} hidden={!visibleColumns.has("active")}>Active</th>
              <th style={th} hidden={!visibleColumns.has("actions")}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={6}>
                <span style={{ color: C.textMuted }}>No rules defined. Click <strong>+ Add rule</strong> to gate a flow.</span>
              </td></tr>
            )}
            {rows.map((r) => (
              <ScrollHighlightRow
                key={r.id}
                rowId={r.id}
                highlightedRowId={highlightedId}
                {...getRowProps(r)}
              >
                <td style={{ ...td, fontFamily: "monospace" }} hidden={!visibleColumns.has("kind")}>{r.kind}</td>
                <td style={td} hidden={!visibleColumns.has("name")}>{r.name}</td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: 11, color: C.textSub }} hidden={!visibleColumns.has("match")}>
                  {JSON.stringify(r.match)}
                </td>
                <td style={{ ...td, fontSize: 12, color: C.textSub }} hidden={!visibleColumns.has("steps")}>
                  {r.steps.map((s) => `${s.step_order}. ${s.mode}/${s.role_required}`).join(" → ")}
                </td>
                <td style={td} hidden={!visibleColumns.has("active")}>
                  <button style={btnSecondary} onClick={(e) => { e.stopPropagation(); void toggleActive(r); }}>
                    {r.is_active ? "Active" : "Inactive"}
                  </button>
                </td>
                <td style={td} hidden={!visibleColumns.has("actions")}>
                  <button style={btnSecondary} onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button>
                  &nbsp;
                  <button style={btnDanger} onClick={(e) => { e.stopPropagation(); void deleteRule(r.id); }}>Delete</button>
                </td>
              </ScrollHighlightRow>
            ))}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <RuleModal
          mode="add"
          onCancel={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <RuleModal
          mode="edit"
          rule={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function RuleModal({ mode, rule, onCancel, onSaved }: {
  mode: "add" | "edit";
  rule?: Rule;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState(rule?.kind ?? "ap_invoice");
  const [name, setName] = useState(rule?.name ?? "");
  const [matchJson, setMatchJson] = useState(JSON.stringify(rule?.match ?? {}, null, 2));
  const [stepsJson, setStepsJson] = useState(
    JSON.stringify(rule?.steps ?? [{ step_order: 1, mode: "any", role_required: "admin" }], null, 2)
  );
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setErr(null);
    let match: unknown;
    let steps: unknown;
    try { match = JSON.parse(matchJson); } catch (e) { setErr(`match JSON: ${(e as Error).message}`); return; }
    try { steps = JSON.parse(stepsJson); } catch (e) { setErr(`steps JSON: ${(e as Error).message}`); return; }

    setSaving(true);
    try {
      let r: Response;
      if (mode === "add") {
        r = await fetch("/api/internal/approval-rules", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind, name, match, steps, is_active: true }),
        });
      } else {
        r = await fetch(`/api/internal/approval-rules/${rule!.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, match, steps }),
        });
      }
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
        padding: 24, width: "min(720px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
      }}>
        <h2 style={{ margin: "0 0 16px 0", fontSize: 18, color: C.text }}>
          {mode === "add" ? "Add rule" : "Edit rule"}
        </h2>

        <Field label="Kind">
          {mode === "edit" ? (
            <input style={{ ...inputStyle, color: C.textMuted }} value={kind} disabled />
          ) : (
            <SearchableSelect
              value={kind || null}
              onChange={(v) => setKind(v)}
              options={KNOWN_KINDS.map((k) => ({ value: k, label: k }))}
              inputStyle={inputStyle}
            />
          )}
        </Field>

        <Field label="Name">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CFO approval > $5k" />
        </Field>

        <Field label="Match (JSON)">
          <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 4 }}>
            Empty object = match all. Operators: min_amount_cents, max_amount_cents, source_kind, vendor_new, entity_id, or, and.
          </div>
          <textarea
            style={{ ...inputStyle, fontFamily: "monospace", minHeight: 80, padding: 10 }}
            value={matchJson}
            onChange={(e) => setMatchJson(e.target.value)}
          />
        </Field>

        <Field label="Steps (JSON array)">
          <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 4 }}>
            Each step: {`{ step_order, mode: "any"|"all", role_required: ${ROLES.join("|")} }`}
          </div>
          <textarea
            style={{ ...inputStyle, fontFamily: "monospace", minHeight: 120, padding: 10 }}
            value={stepsJson}
            onChange={(e) => setStepsJson(e.target.value)}
          />
        </Field>

        {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginTop: 8, fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btnSecondary} onClick={onCancel} disabled={saving}>Cancel</button>
          <button style={btnPrimary} onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : mode === "add" ? "Create" : "Save"}
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
