// src/tanda/InternalB2BPriceList.tsx
//
// Tangerine P18-F — internal B2B Price List admin panel.
// Manage wholesale prices for the B2B portal. A row is keyed by
// (customer | tier | default) × style. Resolution at lookup time is
// most-specific-first: customer match > tier match > default (no customer).
// Wraps /api/internal/b2b-price-list and /api/internal/b2b-price-list/:id.

import { useEffect, useState } from "react";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import SearchableSelect from "./components/SearchableSelect";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

// Universal column-visibility registry for this panel (operator ask #1).
const B2B_PRICELIST_TABLE_KEY = "tangerine:b2bpricelist:columns";
const B2B_PRICELIST_COLUMNS: ColumnDef[] = [
  { key: "customer", label: "Customer" },
  { key: "tier",     label: "Tier" },
  { key: "style",    label: "Style" },
  { key: "price",    label: "Price" },
  { key: "min_qty",  label: "Min qty" },
  { key: "active",   label: "Active" },
];

type EmbeddedCustomer = { id: string; name: string; customer_code: string | null } | null;
type EmbeddedStyle = { id: string; style_code: string | null; style_name: string | null } | null;

type PriceRow = {
  id: string;
  entity_id: string;
  customer_id: string | null;
  customer_tier: string | null;
  style_id: string;
  currency: string;
  price_cents: number;
  min_qty: number | string;
  effective_from: string | null;
  effective_to: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  customer: EmbeddedCustomer;
  style: EmbeddedStyle;
};

type Customer = { id: string; name: string; customer_code?: string | null };
type Style = { id: string; style_code: string | null; style_name?: string | null };

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

function fmtPrice(cents: number, currency: string): string {
  const dollars = (cents || 0) / 100;
  return `${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
function styleLabel(s: EmbeddedStyle | Style | null): string {
  if (!s) return "—";
  const code = s.style_code || "—";
  return s.style_name ? `${code} — ${s.style_name}` : code;
}
function customerLabel(row: PriceRow): string {
  if (!row.customer_id) return "Default (all customers)";
  if (row.customer) return row.customer.customer_code ? `${row.customer.name} (${row.customer.customer_code})` : row.customer.name;
  return "—";
}

export default function InternalB2BPriceList() {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [styles, setStyles] = useState<Style[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<PriceRow | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { getRowProps } = useRowClickEdit<PriceRow>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit price for ${styleLabel(r.style)}`,
  });

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    B2B_PRICELIST_TABLE_KEY,
    B2B_PRICELIST_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/b2b-price-list?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as PriceRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced, includeInactive]);

  useEffect(() => {
    fetch("/api/internal/customer-master?limit=5000")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setCustomers(arr as Customer[]); })
      .catch(() => {});
    fetch("/api/internal/style-master?limit=10000")
      .then((r) => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) {
          setStyles(data.map((s: Record<string, unknown>) => ({
            id: String(s.id),
            style_code: (s.style_code as string) ?? null,
            style_name: (s.style_name as string) ?? null,
          })));
        }
      })
      .catch(() => {});
  }, []);

  async function del(row: PriceRow) {
    if (!(await confirmDialog(`Delete this price-list row for ${styleLabel(row.style)} (${customerLabel(row)})?`))) return;
    try {
      const r = await fetch(`/api/internal/b2b-price-list/${row.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>B2B Price List</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add price</button>
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
        Resolution: customer match &gt; tier match &gt; default (no customer).
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search tier…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, maxWidth: 240 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <TablePrefsButton
          tableKey={B2B_PRICELIST_TABLE_KEY}
          columns={B2B_PRICELIST_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={rows.map((r) => ({
            customer: customerLabel(r),
            customer_tier: r.customer_tier || "",
            style: styleLabel(r.style),
            price_cents: r.price_cents,
            currency: r.currency,
            min_qty: r.min_qty,
            effective_from: r.effective_from || "",
            effective_to: r.effective_to || "",
            is_active: r.is_active,
          })) as unknown as Array<Record<string, unknown>>}
          filename="b2b-price-list"
          sheetName="B2B Price List"
          columns={[
            { key: "customer",       header: "Customer" },
            { key: "customer_tier",  header: "Tier" },
            { key: "style",          header: "Style" },
            { key: "price_cents",    header: "Price", format: "currency_cents" },
            { key: "currency",       header: "Currency" },
            { key: "min_qty",        header: "Min Qty", format: "number" },
            { key: "effective_from", header: "Effective From" },
            { key: "effective_to",   header: "Effective To" },
            { key: "is_active",      header: "Active" },
          ] as ExportColumn<Record<string, unknown>>[]}
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
            No price-list rows yet. Click &quot;Add price&quot; to create one.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("customer")}>Customer</th>
                <th style={th} hidden={!isVisible("tier")}>Tier</th>
                <th style={th} hidden={!isVisible("style")}>Style</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("price")}>Price</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("min_qty")}>Min qty</th>
                <th style={th} hidden={!isVisible("active")}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ScrollHighlightRow
                  key={r.id}
                  rowId={r.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(r)}
                  style={!r.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={td} hidden={!isVisible("customer")}>{customerLabel(r)}</td>
                  <td style={td} hidden={!isVisible("tier")}>{r.customer_tier || "—"}</td>
                  <td style={td} hidden={!isVisible("style")}>{styleLabel(r.style)}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("price")}>{fmtPrice(r.price_cents, r.currency)}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("min_qty")}>{r.min_qty || "—"}</td>
                  <td style={td} hidden={!isVisible("active")}>{r.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(r); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(r); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <PriceFormModal mode="add" customers={customers} styles={styles} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <PriceFormModal mode="edit" row={editing} customers={customers} styles={styles} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  row?: PriceRow;
  customers: Customer[];
  styles: Style[];
  onClose: () => void;
  onSaved: () => void;
}

function PriceFormModal({ mode, row, customers, styles, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    customer_id:    row?.customer_id ?? "",
    customer_tier:  row?.customer_tier ?? "",
    style_id:       row?.style_id ?? "",
    currency:       row?.currency ?? "USD",
    price:          row?.price_cents != null ? (row.price_cents / 100).toFixed(2) : "",
    min_qty:        row?.min_qty != null ? String(row.min_qty) : "0",
    effective_from: row?.effective_from ?? "",
    effective_to:   row?.effective_to ?? "",
    is_active:      row?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const priceNum = parseFloat(form.price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        throw new Error("Price must be a non-negative number");
      }
      const body: Record<string, unknown> = {
        customer_id:    form.customer_id.trim() === "" ? null : form.customer_id,
        customer_tier:  form.customer_tier.trim() === "" ? null : form.customer_tier.trim(),
        style_id:       form.style_id,
        currency:       form.currency.trim().toUpperCase() || "USD",
        price_cents:    Math.round(priceNum * 100),
        min_qty:        form.min_qty.trim() === "" ? 0 : parseFloat(form.min_qty),
        effective_from: form.effective_from.trim() === "" ? null : form.effective_from.trim(),
        effective_to:   form.effective_to.trim() === "" ? null : form.effective_to.trim(),
        is_active:      form.is_active,
      };
      const url = mode === "add" ? "/api/internal/b2b-price-list" : `/api/internal/b2b-price-list/${row!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const customerOptions = [
    { value: "", label: "Default (all customers)" },
    ...customers.map((c) => ({
      value: c.id,
      label: c.customer_code ? `${c.name} (${c.customer_code})` : c.name,
      searchHaystack: `${c.name} ${c.customer_code || ""}`,
    })),
  ];
  const styleOptions = styles.map((s) => ({
    value: s.id,
    label: styleLabel(s),
    searchHaystack: `${s.style_code || ""} ${s.style_name || ""}`,
  }));

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(680px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add price" : "Edit price"}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Customer (blank = default/all)">
            <SearchableSelect
              value={form.customer_id || ""}
              onChange={(v) => setForm({ ...form, customer_id: v })}
              options={customerOptions}
              placeholder="Default (all customers)"
            />
          </Field>
          <Field label="Customer tier (optional)">
            <input
              type="text"
              value={form.customer_tier}
              onChange={(e) => setForm({ ...form, customer_tier: e.target.value })}
              style={inputStyle}
              placeholder="e.g. GOLD"
            />
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Style *">
              <SearchableSelect
                value={form.style_id || null}
                onChange={(v) => setForm({ ...form, style_id: v })}
                options={styleOptions}
                placeholder="Search style code or name…"
              />
            </Field>
          </div>
          <Field label="Price (per unit) *">
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              style={inputStyle}
              placeholder="0.00"
            />
          </Field>
          <Field label="Currency">
            <input
              type="text"
              maxLength={3}
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
              style={inputStyle}
              placeholder="USD"
            />
          </Field>
          <Field label="Min qty">
            <input
              type="number"
              min="0"
              step="0.0001"
              value={form.min_qty}
              onChange={(e) => setForm({ ...form, min_qty: e.target.value })}
              style={inputStyle}
              placeholder="0"
            />
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              is_active
            </label>
          </Field>
          <Field label="Effective from (optional)">
            <input
              type="date"
              value={form.effective_from}
              onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Effective to (optional)">
            <input
              type="date"
              value={form.effective_to}
              onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{
          marginTop: 14, padding: "8px 12px",
          background: "#0b1220", border: `1px dashed ${C.cardBdr}`,
          borderRadius: 6, fontSize: 11, color: C.textMuted, lineHeight: 1.5,
        }}>
          Resolution: customer match &gt; tier match &gt; default (no customer). Leave
          the customer blank for a default price that applies to all customers.
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
