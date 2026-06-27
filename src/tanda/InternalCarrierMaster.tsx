// src/tanda/InternalCarrierMaster.tsx
//
// Tangerine — Carrier Master admin panel.
// List + search + active toggle + create + edit + hard-delete.
// Pre-populated with 16 common carriers (UPS, FedEx, USPS, DHL, …).
// Wraps /api/internal/carriers and /api/internal/carriers/:id.
//
// Carrier codes (e.g. "UPS", "FEDEX") are OPERATOR-SUPPLIED on create;
// they are locked (read-only) after creation. This differs from server-
// auto-coded masters (RMA Reasons, Warehouses) where the code is generated.

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

const CARRIERS_TABLE_KEY = "tangerine:carriermaster:columns";
const CARRIER_COLUMNS: ColumnDef[] = [
  { key: "code",                  label: "Code" },
  { key: "name",                  label: "Name" },
  { key: "carrier_type",          label: "Type" },
  { key: "tracking_url_template", label: "Tracking URL" },
  { key: "sort_order",            label: "Sort" },
  { key: "is_active",             label: "Active" },
];

const CARRIER_TYPE_LABELS: Record<string, string> = {
  parcel: "Parcel",
  ltl:    "LTL",
  ocean:  "Ocean",
  air:    "Air",
  other:  "Other",
};

type Carrier = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  carrier_type: string;
  tracking_url_template: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
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
  colorScheme: "dark",
};
// Greyed, read-only display for locked codes.
const readonlyCodeStyle: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  boxSizing: "border-box", display: "flex", alignItems: "center",
  fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600,
  opacity: 0.85,
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

export default function InternalCarrierMaster() {
  const [rows, setRows] = useState<Carrier[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Carrier | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(
    CARRIERS_TABLE_KEY,
    CARRIER_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { getRowProps } = useRowClickEdit<Carrier>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit carrier ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/carriers?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Carrier[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [includeInactive]);

  async function del(c: Carrier) {
    if (!(await confirmDialog(`Delete carrier ${c.code} (${c.name})?\nHistorical shipments that used this carrier are unaffected — the carrier name is stored as plain text in shipment records. Toggle is_active=false instead if you want to retire it from the picker while keeping history.`))) return;
    try {
      const r = await fetch(`/api/internal/carriers/${c.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Carrier Master</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            Shipping carriers. Pre-populated with common carriers — add or deactivate as needed.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add carrier</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
        <input
          type="text"
          placeholder="Search code or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          style={{ ...inputStyle, maxWidth: 280 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="carriers"
          sheetName="Carriers"
          columns={[
            { key: "code",                  header: "Code" },
            { key: "name",                  header: "Name" },
            { key: "carrier_type",          header: "Type" },
            { key: "tracking_url_template", header: "Tracking URL" },
            { key: "sort_order",            header: "Sort", format: "number" },
            { key: "is_active",             header: "Active" },
            { key: "created_at",            header: "Created", format: "datetime" },
            { key: "updated_at",            header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={CARRIERS_TABLE_KEY}
          columns={CARRIER_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No carriers found. Add one with &quot;+ Add carrier&quot; — or check &quot;Show inactive&quot;
            if you may have deactivated all of them.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("carrier_type")}>Type</th>
                <th style={th} hidden={!isVisible("tracking_url_template")}>Tracking URL</th>
                <th style={th} hidden={!isVisible("sort_order")}>Sort</th>
                <th style={th} hidden={!isVisible("is_active")}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <ScrollHighlightRow
                  key={c.id}
                  rowId={c.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(c)}
                  style={!c.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>{c.code}</td>
                  <td style={td} hidden={!isVisible("name")}>{c.name}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("carrier_type")}>{CARRIER_TYPE_LABELS[c.carrier_type] ?? c.carrier_type}</td>
                  <td style={{ ...td, color: C.textSub, fontSize: 11, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} hidden={!isVisible("tracking_url_template")} title={c.tracking_url_template ?? undefined}>{c.tracking_url_template || "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("sort_order")}>{c.sort_order}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{c.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(c); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(c); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <CarrierFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <CarrierFormModal
          mode="edit"
          carrier={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  carrier?: Carrier;
  onClose: () => void;
  onSaved: () => void;
}

function CarrierFormModal({ mode, carrier, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:                  carrier?.name ?? "",
    carrier_type:          carrier?.carrier_type ?? "parcel",
    tracking_url_template: carrier?.tracking_url_template ?? "",
    sort_order:            carrier?.sort_order != null ? String(carrier.sort_order) : "0",
    is_active:             carrier?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/carriers" : `/api/internal/carriers/${carrier!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";

      // code is auto-generated (CARR-NNNNN) server-side + immutable — never sent.
      const body = {
        name:                  form.name.trim(),
        carrier_type:          form.carrier_type,
        tracking_url_template: form.tracking_url_template.trim() || null,
        sort_order:            form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active:             form.is_active,
      };

      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add carrier" : `Edit ${carrier!.code}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code (auto-generated)">
            {/* Code is auto-generated (CARR-NNNNN) + immutable — display only.
                Existing meaningful codes (ABF/AMAZON …) are preserved. */}
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(assigned on save)</span>
                : (carrier?.code || "—")}
            </div>
          </Field>

          <Field label="Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. United Parcel Service"
              autoFocus={mode === "edit"}
            />
          </Field>

          <Field label="Carrier type">
            <SearchableSelect
              value={form.carrier_type || null}
              onChange={(v) => setForm({ ...form, carrier_type: v })}
              options={[
                { value: "parcel", label: "Parcel" },
                { value: "ltl", label: "LTL" },
                { value: "ocean", label: "Ocean" },
                { value: "air", label: "Air" },
                { value: "other", label: "Other" },
              ]}
              inputStyle={{ ...inputStyle, cursor: "pointer" }}
            />
          </Field>

          <Field label="Sort order">
            <input
              type="number"
              min="0"
              step="1"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
              style={inputStyle}
              placeholder="0"
            />
          </Field>

          <Field label="Tracking URL template" style={{ gridColumn: "1 / -1" }}>
            <input
              type="text"
              value={form.tracking_url_template}
              onChange={(e) => setForm({ ...form, tracking_url_template: e.target.value })}
              style={inputStyle}
              placeholder="https://…?tracknum={tracking}  (use {tracking} as placeholder)"
            />
          </Field>

          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
              />
              is_active
            </label>
          </Field>
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={style}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
