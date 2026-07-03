// src/tanda/InternalPaymentTerms.tsx
//
// Tangerine P3 Chunk 9 — Payment Terms Master admin panel.
// List + search + active toggle + create + edit + hard-delete (rejected with
// reference detail if any vendors/customers/invoices still reference it).
// Wraps /api/internal/payment-terms and /api/internal/payment-terms/:id.
//
// Payment terms are reference data used to compute due_date on AP/AR invoices:
//   invoices.due_date = invoice.posting_date + payment_terms.due_days
// The migration seeds the common ones (COD, NET10..NET90, DUE_ON_RECEIPT,
// 2_10_NET30) — operators add edge-case terms here (NET75, special discounts).

import { useEffect, useState } from "react";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const PAYMENT_TERMS_TABLE_KEY = "tangerine:paymentterms:columns";
const PAYMENT_TERM_COLUMNS: ColumnDef[] = [
  { key: "code",          label: "Code" },
  { key: "name",          label: "Name" },
  { key: "due_days",      label: "Due days" },
  { key: "discount_pct",  label: "Disc. %" },
  { key: "discount_days", label: "Disc. days" },
  { key: "is_active",     label: "Active" },
];

type PaymentTerm = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  due_days: number;
  discount_pct: number | string;
  discount_days: number;
  is_active: boolean;
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
};
// Chunk M — greyed, read-only display for server-generated codes (operator item 14).
// Sized to match its siblings in the add/edit grid: SAME WIDTH as the Due Date
// (Due days) input — full column, width:100% like inputStyle — and SAME HEIGHT
// as the Name input — box-sizing:border-box + flex-centering and no fixed
// minHeight so the box height equals a single-line text input (pattern from
// InternalFabricCodes.tsx readonlyCodeStyle).
const readonlyCodeStyle: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
  width: "100%", boxSizing: "border-box",
  display: "flex", alignItems: "center",
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

function formatPct(n: number | string): string {
  const x = typeof n === "number" ? n : parseFloat(n);
  if (!Number.isFinite(x) || x === 0) return "—";
  return `${(x * 100).toFixed(2)}%`;
}

function previewDueDate(dueDays: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(today);
  due.setDate(due.getDate() + dueDays);
  // YYYY-MM-DD in local TZ to avoid surprising operators with UTC drift
  const yyyy = due.getFullYear();
  const mm = String(due.getMonth() + 1).padStart(2, "0");
  const dd = String(due.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function InternalPaymentTerms() {
  const [rows, setRows] = useState<PaymentTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentTerm | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(
    PAYMENT_TERMS_TABLE_KEY,
    PAYMENT_TERM_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:paymentterms:sort",
    // discount_pct may arrive as a numeric string — coerce so it sorts numerically.
    accessors: { discount_pct: (r) => (typeof r.discount_pct === "number" ? r.discount_pct : parseFloat(r.discount_pct as string)) },
  });

  const { getRowProps } = useRowClickEdit<PaymentTerm>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit payment term ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/payment-terms?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as PaymentTerm[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced, includeInactive]);

  async function del(pt: PaymentTerm) {
    if (!(await confirmDialog(`Delete payment term ${pt.code} (${pt.name})?\nWill fail if any vendor / customer / invoice still references it — toggle is_active=false in that case.`))) return;
    try {
      const r = await fetch(`/api/internal/payment-terms/${pt.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && j.references) {
          const d = j.references;
          notify(`Cannot delete — still referenced by:\n  ${d.vendors} vendor(s)\n  ${d.customers} customer(s)\n  ${d.invoices} invoice(s)\n\nReassign those rows first, or toggle is_active=false instead.`, "error");
          return;
        }
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Payment Terms</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add term</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search code or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
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
          filename="payment-terms"
          sheetName="Payment Terms"
          columns={[
            { key: "code",          header: "Code" },
            { key: "name",          header: "Name" },
            { key: "due_days",      header: "Due Days",      format: "number" },
            { key: "discount_pct",  header: "Discount %",    format: "number" },
            { key: "discount_days", header: "Discount Days", format: "number" },
            { key: "is_active",     header: "Active" },
            { key: "created_at",    header: "Created", format: "datetime" },
            { key: "updated_at",    header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={PAYMENT_TERMS_TABLE_KEY}
          columns={PAYMENT_TERM_COLUMNS}
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
            No payment terms found. The migration seeded the common ones (NET30, COD, etc.)
            — check &quot;Show inactive&quot; if you may have deactivated all of them.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("code")} />
                <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("name")} />
                <SortableTh label="Due days" sortKey="due_days" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("due_days")} />
                <SortableTh label="Disc. %" sortKey="discount_pct" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("discount_pct")} />
                <SortableTh label="Disc. days" sortKey="discount_days" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("discount_days")} />
                <SortableTh label="Active" sortKey="is_active" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("is_active")} />
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((pt) => (
                <ScrollHighlightRow
                  key={pt.id}
                  rowId={pt.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(pt)}
                  style={!pt.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>{pt.code}</td>
                  <td style={td} hidden={!isVisible("name")}>{pt.name}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("due_days")}>{pt.due_days}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("discount_pct")}>{formatPct(pt.discount_pct)}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("discount_days")}>{pt.discount_days || "—"}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{pt.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(pt); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(pt); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <PaymentTermFormModal mode="add" onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <PaymentTermFormModal mode="edit" term={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  term?: PaymentTerm;
  onClose: () => void;
  onSaved: () => void;
}

function PaymentTermFormModal({ mode, term, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    code:          term?.code          ?? "",
    name:          term?.name          ?? "",
    due_days:      term?.due_days      != null ? String(term.due_days)      : "30",
    discount_pct:  term?.discount_pct  != null
      ? String(typeof term.discount_pct === "number" ? term.discount_pct : parseFloat(term.discount_pct as string))
      : "0",
    discount_days: term?.discount_days != null ? String(term.discount_days) : "0",
    is_active:     term?.is_active     ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dueDaysNum = parseInt(form.due_days, 10);
  const previewSafe = Number.isInteger(dueDaysNum) && dueDaysNum >= 0;

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      let url: string;
      let method: string;
      let body: Record<string, unknown>;
      if (mode === "add") {
        url = "/api/internal/payment-terms";
        method = "POST";
        body = {
          // Chunk M — code is server-generated; never sent from the client.
          name:          form.name.trim(),
          due_days:      parseInt(form.due_days, 10),
          discount_pct:  form.discount_pct.trim() === "" ? 0 : parseFloat(form.discount_pct),
          discount_days: form.discount_days.trim() === "" ? 0 : parseInt(form.discount_days, 10),
          is_active:     form.is_active,
        };
      } else {
        url = `/api/internal/payment-terms/${term!.id}`;
        method = "PATCH";
        // code is locked — don't send.
        body = {
          name:          form.name.trim(),
          due_days:      parseInt(form.due_days, 10),
          discount_pct:  form.discount_pct.trim() === "" ? 0 : parseFloat(form.discount_pct),
          discount_days: form.discount_days.trim() === "" ? 0 : parseInt(form.discount_days, 10),
          is_active:     form.is_active,
        };
      }
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(640px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add payment term" : `Edit ${term!.code}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            {/* Chunk M — codes are server-generated + read-only (operator item 14). */}
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span>
                : (term?.code || "—")}
            </div>
          </Field>
          <Field label="Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Net 75"
            />
          </Field>
          <Field label="Due days *">
            <input
              type="number"
              min="0"
              step="1"
              value={form.due_days}
              onChange={(e) => setForm({ ...form, due_days: e.target.value })}
              style={inputStyle}
              placeholder="30"
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
          <Field label="Discount % (decimal, 0..0.9999)">
            <input
              type="number"
              min="0"
              max="0.9999"
              step="0.0001"
              value={form.discount_pct}
              onChange={(e) => setForm({ ...form, discount_pct: e.target.value })}
              style={inputStyle}
              placeholder="0  (e.g. 0.02 for 2%)"
            />
          </Field>
          <Field label="Discount days">
            <input
              type="number"
              min="0"
              step="1"
              value={form.discount_days}
              onChange={(e) => setForm({ ...form, discount_days: e.target.value })}
              style={inputStyle}
              placeholder="0"
            />
          </Field>
        </div>

        <div style={{
          marginTop: 14, padding: "8px 12px",
          background: "#0b1220", border: `1px dashed ${C.cardBdr}`,
          borderRadius: 6, fontSize: 11, color: C.textMuted, lineHeight: 1.5,
        }}>
          {previewSafe ? (
            <>If an invoice is posted <strong>today</strong>, its due date will be <strong style={{ color: C.text }}>{previewDueDate(dueDaysNum)}</strong> ({dueDaysNum} day{dueDaysNum === 1 ? "" : "s"} from now).</>
          ) : (
            <>Enter a non-negative integer in &quot;Due days&quot; to preview the computed due date.</>
          )}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
