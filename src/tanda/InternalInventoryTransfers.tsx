// src/tanda/InternalInventoryTransfers.tsx
//
// Tangerine P3 Chunk 7 - M37 Inventory Transfers.
//
// List + filter panel for location-to-location moves, plus two entry paths:
//   • "▦ Matrix transfer" — pick FROM + TO location, pick a style, then type a
//     transfer qty into an editable color × size (× inseam) grid. On submit one
//     transfer row is created per non-zero cell (each cell resolved to a SKU id
//     via /api/internal/style-matrix/resolve-sku). Mirrors the Matrix Adjustment
//     and Matrix Sales-Order entry UX exactly.
//   • "+ Add" — single-variant transfer (one SKU, one qty) as the secondary
//     option.
// Both POST to the EXISTING /api/internal/inventory-transfers create endpoint.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import SearchableSelect from "./components/SearchableSelect";
import { EditableSizeMatrix, matrixCellKey } from "../shared/matrix";
import type { EditableMatrixRow } from "../shared/matrix";
import { notify, confirmDialog } from "../shared/ui/warn";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import { fmtDateDisplay } from "../utils/tandaTypes";

// ─────────────────────────────────────────────────────────────────────────
// Transfer Reason picker (transfer_reason_master, #985). A SearchableSelect
// over /api/internal/transfer-reasons with inline add-new. Shared by both the
// single-variant and matrix entry modals: a transfer reason is REQUIRED on
// every transfer (the chosen reason NAME flows into the transfer's notes), so
// the save is blocked + warned when none is picked.
// ─────────────────────────────────────────────────────────────────────────
type TransferReason = { id: string; code: string; name: string; is_active: boolean };

function useTransferReasons() {
  const [reasons, setReasons] = useState<TransferReason[]>([]);
  async function reload() {
    try {
      const r = await fetch(`/api/internal/transfer-reasons`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data)) setReasons(data as TransferReason[]);
    } catch { /* non-fatal */ }
  }
  useEffect(() => { void reload(); }, []);
  // Create a new reason from a typed query; returns the created NAME (or null).
  async function addReason(query: string): Promise<string | null> {
    const name = query.trim();
    if (!name) return null;
    try {
      const r = await fetch(`/api/internal/transfer-reasons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { notify(`Could not add reason: ${out.error || r.status}`, "error"); return null; }
      await reload();
      return (out.name as string) || name;
    } catch (e) {
      notify(`Could not add reason: ${(e as Error).message}`, "error");
      return null;
    }
  }
  return { reasons, addReason };
}

type Warehouse = { id: string; code: string; name: string };

function useWarehouses() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  useEffect(() => {
    fetch("/api/internal/warehouses")
      .then((r) => r.ok ? r.json() : [])
      .then((d) => { if (Array.isArray(d)) setWarehouses(d); })
      .catch(() => {/* non-fatal */});
  }, []);
  return warehouses;
}

function TransferReasonPicker({
  reasons, value, onChange, onAddNew,
}: {
  reasons: TransferReason[];
  value: string;
  onChange: (v: string) => void;
  onAddNew: (query: string) => void;
}) {
  return (
    <SearchableSelect
      value={value || null}
      onChange={(v) => onChange(v || "")}
      options={reasons.map((t) => ({
        value: t.name,
        label: t.name,
        searchHaystack: `${t.code} ${t.name}`,
      }))}
      placeholder="Search transfer reason…"
      emptyText="No transfer reasons — type one and choose Add new"
      onAddNew={onAddNew}
      addNewLabel={(q) => `+ Add "${q}" as a new transfer reason`}
    />
  );
}

// Universal column-visibility registry for this panel (operator ask #1).
const INV_XFER_TABLE_KEY = "tangerine:inventorytransfers:columns";
const INV_XFER_COLUMNS: ColumnDef[] = [
  { key: "style", label: "Style" },
  { key: "qty",   label: "Qty" },
  { key: "from",  label: "From" },
  { key: "to",    label: "To" },
  { key: "date",  label: "Date" },
  { key: "by",      label: "By" },
  { key: "created", label: "Created" },
  { key: "notes", label: "Notes" },
];

type InventoryTransfer = {
  id: string;
  entity_id: string;
  item_id: string;
  qty: number;
  from_location: string;
  to_location: string;
  transfer_date: string;
  notes: string | null;
  posted_je_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id?: string | null;
  created_by_name?: string | null;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", danger: "#EF4444", warn: "#F59E0B",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12,
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
  color: C.text, fontSize: 13,
};
const modalBg: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};
const modalCard: React.CSSProperties = {
  background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
  padding: 24, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
};

type StyleMasterRow = { id: string; style_code: string; style_name: string | null };
type WarehouseRow = { id: string; code: string; name: string };

export default function InternalInventoryTransfers() {
  const [rows, setRows] = useState<InventoryTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Style SearchableSelect filter (replaces free-text UUID/SKU input).
  const [filterStyleId, setFilterStyleId] = useState("");
  // Warehouse SearchableSelect filters (replaces free-text from/to inputs).
  const [filterFromCode, setFilterFromCode] = useState("");
  const [filterToCode, setFilterToCode] = useState("");
  // Item 4 — filter by who created the transfer (client-side over loaded rows).
  const [filterUser, setFilterUser] = useState("");
  // Master data for filter dropdowns.
  const [styles, setStyles] = useState<StyleMasterRow[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  // Resolve item_id → human SKU label (no raw UUIDs in the table). Populated
  // from /api/internal/items?ids= for the ids present in the current rows.
  const [skuById, setSkuById] = useState<Record<string, string>>({});
  function itemLabel(id: string): string {
    return skuById[id] || "—";
  }

  // Style id → sku_code map for the list display.
  const styleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of styles) m.set(s.id, s.style_code);
    return m;
  }, [styles]);

  // Entry modals. "+ Add" opens a chooser that routes to single / matrix
  // (mirrors the #974 Adjustments AddModeChooser).
  const [addChooserOpen, setAddChooserOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  // Edit modal state.
  const [editingRow, setEditingRow] = useState<InventoryTransfer | null>(null);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    INV_XFER_TABLE_KEY,
    INV_XFER_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:inventorytransfers:sort",
    accessors: {
      style: (t) => itemLabel(t.item_id),
      from: (t) => t.from_location,
      to: (t) => t.to_location,
      date: (t) => t.transfer_date,
    },
  });

  // Load styles and warehouses once on mount for filter dropdowns.
  useEffect(() => {
    fetch("/api/internal/style-master?limit=10000")
      .then((r) => r.json())
      .then((d) => setStyles(Array.isArray(d) ? d : []))
      .catch(() => {});
    fetch("/api/internal/warehouses")
      .then((r) => r.json())
      .then((d) => setWarehouses(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (filterStyleId) params.set("item_id", filterStyleId);
      if (filterFromCode) params.set("from_location", filterFromCode);
      if (filterToCode) params.set("to_location", filterToCode);
      const r = await fetch(`/api/internal/inventory-transfers?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [filterStyleId, filterFromCode, filterToCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve the item ids in the current rows to sku_code labels.
  useEffect(() => {
    const ids = Array.from(new Set(rows.map((t) => t.item_id).filter(Boolean)))
      .filter((id) => !(id in skuById));
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/internal/items?ids=${encodeURIComponent(ids.join(","))}`);
        if (!r.ok) return;
        const data = (await r.json()) as Array<{ id: string; sku_code: string | null }>;
        if (cancelled) return;
        setSkuById((prev) => {
          const next = { ...prev };
          for (const it of data) next[it.id] = it.sku_code || "—";
          return next;
        });
      } catch { /* leave as "—" */ }
    })();
    return () => { cancelled = true; };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Item 4 — user filter is client-side (over the loaded rows); style/from/to are
  // server-side via query params.
  const displayRows = useMemo(
    () => (filterUser ? sorted.filter((t) => (t.created_by_user_id || "") === filterUser) : sorted),
    [sorted, filterUser],
  );
  // Distinct creators present in the loaded rows → user-filter options.
  const userOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of rows) if (t.created_by_user_id) m.set(t.created_by_user_id, t.created_by_name || t.created_by_user_id.slice(0, 8));
    return [{ value: "", label: "All users" }, ...[...m].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
  }, [rows]);

  const fmtDate = fmtDateDisplay;

  // Filter dropdown options.
  const styleOpts = useMemo(() => [
    { value: "", label: "All styles" },
    ...styles.map((s) => ({
      value: s.id,
      label: s.style_name ? `${s.style_code} — ${s.style_name}` : s.style_code,
    })),
  ], [styles]);

  const whOpts = useMemo(() => warehouses.map((w) => ({
    value: w.code,
    label: `${w.code} — ${w.name}`,
  })), [warehouses]);

  async function handleDelete(row: InventoryTransfer) {
    const label = styleById.get(row.item_id) ?? skuById[row.item_id] ?? row.item_id.slice(0, 8);
    if (!(await confirmDialog(`Delete this transfer (${label})? Only unposted transfers can be deleted.`))) return;
    const r = await fetch(`/api/internal/inventory-transfers/${row.id}`, { method: "DELETE" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      notify(`Delete failed: ${(e as { error?: string }).error || r.status}`, "error");
      return;
    }
    void load();
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Inventory Transfers</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Location-to-location moves. Use "+ Add" to pick a single variant or a size-grid (matrix) transfer.
        </span>
        <button
          type="button"
          style={{ ...btnPrimary, marginLeft: "auto" }}
          onClick={() => setAddChooserOpen(true)}
        >
          + Add
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ width: 280 }}>
          <SearchableSelect
            value={filterStyleId || null}
            onChange={(v) => setFilterStyleId(v || "")}
            options={styleOpts}
            placeholder="All styles"
          />
        </div>
        <div style={{ width: 220 }}>
          <SearchableSelect
            value={filterFromCode || null}
            onChange={(v) => setFilterFromCode(v || "")}
            options={[{ value: "", label: "All from warehouses" }, ...whOpts]}
            placeholder="From warehouse"
          />
        </div>
        <div style={{ width: 220 }}>
          <SearchableSelect
            value={filterToCode || null}
            onChange={(v) => setFilterToCode(v || "")}
            options={[{ value: "", label: "All to warehouses" }, ...whOpts]}
            placeholder="To warehouse"
          />
        </div>
        <div style={{ width: 200 }} title="Filter by who logged the transfer">
          <SearchableSelect
            value={filterUser || null}
            onChange={(v) => setFilterUser(v || "")}
            options={userOptions}
            placeholder="All users"
          />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          <TablePrefsButton
            tableKey={INV_XFER_TABLE_KEY}
            columns={INV_XFER_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
          />
          <ExportButton
            rows={rows as unknown as Array<Record<string, unknown>>}
            filename="inventory-transfers"
            sheetName="Inventory Transfers"
            columns={[
              { key: "transfer_date",  header: "Date",          format: "date" },
              { key: "item_id",        header: "Item ID" },
              { key: "qty",            header: "Qty",           format: "number" },
              { key: "from_location",  header: "From" },
              { key: "to_location",    header: "To" },
              { key: "notes",          header: "Notes" },
              { key: "posted_je_id",   header: "Posted JE" },
              { key: "created_at",     header: "Created",       format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortableTh label="Style" sortKey="style" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("style")} />
              <SortableTh label="Qty" sortKey="qty" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("qty")} />
              <SortableTh label="From" sortKey="from" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("from")} />
              <SortableTh label="To" sortKey="to" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("to")} />
              <SortableTh label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("date")} />
              <th style={th} hidden={!isVisible("by")}>By</th>
              <th style={th} hidden={!isVisible("created")}>Created</th>
              <SortableTh label="Notes" sortKey="notes" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("notes")} />
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={9}>Loading…</td></tr>
            )}
            {!loading && displayRows.length === 0 && (
              <tr><td style={td} colSpan={9}>
                <span style={{ color: C.textMuted }}>
                  No transfers logged yet. Use "+ Add" to log a single-variant or matrix transfer.
                </span>
              </td></tr>
            )}
            {displayRows.map((t) => (
              <tr key={t.id}>
                <td style={{ ...td, color: C.textSub }} hidden={!isVisible("style")}>
                  {styleById.get(t.item_id) ?? skuById[t.item_id] ?? t.item_id.slice(0, 8)}
                </td>
                <td style={td} hidden={!isVisible("qty")}>{t.qty}</td>
                <td style={td} hidden={!isVisible("from")}>{t.from_location}</td>
                <td style={td} hidden={!isVisible("to")}>{t.to_location}</td>
                <td style={td} hidden={!isVisible("date")}>{fmtDate(t.transfer_date)}</td>
                <td style={{ ...td, color: C.textSub }} hidden={!isVisible("by")}>{t.created_by_name || "—"}</td>
                <td style={{ ...td, color: C.textSub, whiteSpace: "nowrap" }} hidden={!isVisible("created")}>{t.created_at ? new Date(t.created_at).toLocaleString("en-US") : "—"}</td>
                <td style={{ ...td, color: C.textSub }} hidden={!isVisible("notes")}>{t.notes || "—"}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  {!t.posted_je_id && (
                    <>
                      <button
                        style={btnSecondary}
                        onClick={() => { setEditingRow(t); setAddChooserOpen(false); }}
                      >Edit</button>
                      {" "}
                      <button
                        style={{ ...btnSecondary, color: C.danger, borderColor: C.danger }}
                        onClick={() => void handleDelete(t)}
                      >Del</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addChooserOpen && (
        <AddModeChooser
          onPick={(mode) => {
            setAddChooserOpen(false);
            if (mode === "single") setAddOpen(true);
            else setMatrixOpen(true);
          }}
          onClose={() => setAddChooserOpen(false)}
        />
      )}

      {addOpen && (
        <SingleTransferModal
          defaultFrom={filterFromCode}
          defaultTo={filterToCode}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}

      {matrixOpen && (
        <MatrixTransferModal
          defaultFrom={filterFromCode}
          defaultTo={filterToCode}
          onClose={() => setMatrixOpen(false)}
          onSaved={() => { setMatrixOpen(false); void load(); }}
        />
      )}

      {editingRow && (
        <EditTransferModal
          row={editingRow}
          onClose={() => setEditingRow(null)}
          onSaved={() => { setEditingRow(null); void load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Add-mode chooser — the single "+ Add" entry point. The operator picks
// whether to add a Single variant transfer or a Matrix (color × size) batch.
// Mirrors the #974 Adjustments AddModeChooser exactly.
// ─────────────────────────────────────────────────────────────────────────
function AddModeChooser({
  onPick, onClose,
}: {
  onPick: (mode: "single" | "matrix") => void;
  onClose: () => void;
}) {
  const tile: React.CSSProperties = {
    flex: 1, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8,
    padding: 20, cursor: "pointer", textAlign: "center", color: C.text,
  };
  return (
    <div style={modalBg} onClick={onClose}>
      <div style={{ ...modalCard, width: "min(480px, 95vw)", boxSizing: "border-box" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>New Inventory Transfer</h2>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          Choose how to enter this transfer.
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" style={tile} onClick={() => onPick("single")}>
            <div style={{ fontSize: 26, marginBottom: 6 }}>＋</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Single variant</div>
            <div style={{ fontSize: 11, color: C.textMuted }}>One SKU, one qty.</div>
          </button>
          <button type="button" style={tile} onClick={() => onPick("matrix")}>
            <div style={{ fontSize: 26, marginBottom: 6 }}>▦</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Matrix</div>
            <div style={{ fontSize: 11, color: C.textMuted }}>Color × size grid; one transfer per non-zero cell.</div>
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" style={btnSecondary} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Single-variant transfer — one SKU, one qty. Secondary entry path.
// ─────────────────────────────────────────────────────────────────────────

function SingleTransferModal({
  defaultFrom, defaultTo, onClose, onSaved,
}: {
  defaultFrom: string;
  defaultTo: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState<string>("1");
  const [fromLoc, setFromLoc] = useState(defaultFrom);
  const [toLoc, setToLoc] = useState(defaultTo);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { reasons, addReason } = useTransferReasons();
  const isAdmin = !!getCachedAuthUserId(); // item 1 — only admins add reasons on the fly
  const warehouses = useWarehouses();
  const whOpts = useMemo(() => warehouses.map((w) => ({ value: w.code, label: `${w.code} — ${w.name}` })), [warehouses]);

  // SKU picker — load a batch of active items so the operator picks by SKU,
  // never a raw UUID. SearchableSelect filters locally (sku / style / desc).
  const [itemOpts, setItemOpts] = useState<Array<{ id: string; sku_code: string | null; style_code: string | null; description: string | null }>>([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/internal/items?limit=5000`);
        if (!r.ok) return;
        const data = await r.json();
        if (Array.isArray(data)) setItemOpts(data);
      } catch { /* non-fatal */ }
    })();
  }, []);

  async function save() {
    setErr(null);
    const qtyNum = Number(qty);
    // A transfer reason is REQUIRED — block + warn via the factored warn UI.
    if (!reason.trim()) { await confirmDialog("Please select a Transfer Reason before saving."); return; }
    if (!itemId.trim()) { setErr("Pick a SKU"); return; }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) { setErr("Qty must be a positive number"); return; }
    if (!fromLoc.trim()) { setErr("From location is required"); return; }
    if (!toLoc.trim()) { setErr("To location is required"); return; }
    if (fromLoc.trim() === toLoc.trim()) { setErr("To location must differ from From location"); return; }
    setSaving(true);
    try {
      // Persist the chosen reason into notes (the reason flows into the
      // transfer's free-text notes; any extra notes are appended).
      const combinedNotes = [reason.trim(), notes.trim()].filter(Boolean).join(" — ");
      const body: Record<string, unknown> = {
        item_id: itemId.trim(),
        qty: qtyNum,
        from_location: fromLoc.trim(),
        to_location: toLoc.trim(),
      };
      if (combinedNotes) body.notes = combinedNotes;
      const actorUid = getCachedAuthUserId();
      if (actorUid) body.created_by_user_id = actorUid;
      const r = await fetch(`/api/internal/inventory-transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      notify("Transfer created.", "success");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={modalBg} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>New Inventory Transfer</h2>

        {err && (
          <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>SKU</label>
        <div style={{ marginBottom: 12 }}>
          <SearchableSelect
            value={itemId || null}
            onChange={(v) => setItemId(v || "")}
            options={itemOpts.map((it) => ({
              value: it.id,
              label: it.sku_code || it.style_code || "—",
              searchHaystack: `${it.sku_code || ""} ${it.style_code || ""} ${it.description || ""}`,
            }))}
            placeholder="Search by SKU / style / description…"
            emptyText="No matching items"
          />
        </div>

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Qty</label>
        <input
          style={{ ...inputStyle, marginBottom: 12 }}
          type="number"
          min="0"
          step="any"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />

        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>From warehouse</label>
            <SearchableSelect value={fromLoc || null} onChange={(v) => setFromLoc(v || "")}
              options={whOpts} placeholder="Search warehouse…" inputStyle={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>To warehouse</label>
            <SearchableSelect value={toLoc || null} onChange={(v) => setToLoc(v || "")}
              options={whOpts} placeholder="Search warehouse…" inputStyle={inputStyle} />
          </div>
        </div>

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Transfer Reason *</label>
        <div style={{ marginBottom: 12 }}>
          <TransferReasonPicker
            reasons={reasons}
            value={reason}
            onChange={setReason}
            onAddNew={(q) => { if (!isAdmin) { notify("Only admins can add transfer reasons. Ask an admin, or pick an existing reason.", "error"); return; } void addReason(q).then((name) => { if (name) setReason(name); }); }}
          />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
            Required. Curate the list in the Transfer Reasons master, or type one and choose "Add new".
          </div>
        </div>

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Notes (optional)</label>
        <textarea
          style={{ ...inputStyle, marginBottom: 12, minHeight: 50, resize: "vertical" }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" style={btnSecondary} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" style={btnPrimary} onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Create Transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MX-XFER — Matrix inventory-transfer entry.
//
// Pick FROM + TO location + optional notes ONCE (applies to the whole batch)
// + a style → fetch /api/internal/style-matrix → editable color × size
// (× inseam) grid. Each cell captures a transfer qty. On "Create transfers"
// each non-zero cell resolves to a SKU id (resolve-sku — reused exactly like
// the adjustments matrix) then POSTs one row to the create endpoint.
// ─────────────────────────────────────────────────────────────────────────

type StyleOption = { id: string; style_code: string; style_name?: string | null };

type MatrixSku = {
  id: string;
  color: string | null;
  size: string | null;
  inseam: string | null;
  length: string | null;
  fit: string | null;
  on_hand_qty?: number | null;
};
type StyleMatrixPayload = {
  style: { id: string; style_code: string; style_name?: string | null };
  sizes: string[];
  colors: string[];
  inseams: string[];
  skus: MatrixSku[];
};

// (color,size,inseam) → existing-SKU lookup key.
function cellKey(color: string | null, size: string | null, inseam: string | null): string {
  return `${color ?? ""}|${size ?? ""}|${inseam ?? ""}`;
}
// Per-row key (color × inseam) used by the grid.
function rowKeyOf(color: string | null, inseam: string | null): string {
  return `${color ?? ""}|${inseam ?? ""}`;
}

function MatrixTransferModal({
  defaultFrom, defaultTo, onClose, onSaved,
}: {
  defaultFrom: string;
  defaultTo: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Batch-level fields (applied to every created transfer).
  const [fromLoc, setFromLoc] = useState(defaultFrom);
  const [toLoc, setToLoc] = useState(defaultTo);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const { reasons, addReason } = useTransferReasons();
  const isAdmin = !!getCachedAuthUserId(); // item 1 — only admins add reasons on the fly
  const warehouses = useWarehouses();
  const whOpts = useMemo(() => warehouses.map((w) => ({ value: w.code, label: `${w.code} — ${w.name}` })), [warehouses]);

  // Style picker.
  const [styleOpts, setStyleOpts] = useState<StyleOption[]>([]);
  const [styleId, setStyleId] = useState("");

  // Loaded matrix + per-cell qty keyed by matrixCellKey(rowKey, size).
  const [matrix, setMatrix] = useState<StyleMatrixPayload | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({});

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  // Load all styles for the picker (SearchableSelect filters locally).
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/internal/style-master?limit=10000`);
        if (!r.ok) return;
        const data = await r.json();
        if (Array.isArray(data)) {
          setStyleOpts(data.map((s: any) => ({
            id: s.id, style_code: s.style_code, style_name: s.style_name,
          })));
        }
      } catch { /* non-fatal */ }
    })();
  }, []);

  // When a style is picked, fetch its matrix and reset qty.
  useEffect(() => {
    if (!styleId) { setMatrix(null); setQtyMap({}); return; }
    setMatrixLoading(true);
    setErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        setMatrix(await r.json() as StyleMatrixPayload);
        setQtyMap({});
      } catch (e) {
        setErr((e as Error).message);
        setMatrix(null);
      } finally {
        setMatrixLoading(false);
      }
    })();
  }, [styleId]);

  // Map (color,size,inseam) → existing SKU id + on-hand, for hint + reuse.
  const skuByCell = useMemo(() => {
    const m = new Map<string, MatrixSku>();
    for (const s of matrix?.skus ?? []) m.set(cellKey(s.color, s.size, s.inseam), s);
    return m;
  }, [matrix]);

  const hasMultiInseam = (matrix?.inseams?.length ?? 0) > 1;
  const sizes = matrix?.sizes ?? [];

  // Grid rows: one per color (× inseam when the style spans multiple inseams).
  const rows = useMemo<EditableMatrixRow[]>(() => {
    if (!matrix) return [];
    const colors = matrix.colors.length
      ? matrix.colors
      : [...new Set((matrix.skus || []).map((s) => s.color).filter(Boolean) as string[])];
    const colorList: (string | null)[] = colors.length ? colors : [null];
    const inseamList: (string | null)[] = hasMultiInseam ? matrix.inseams : [null];
    const out: EditableMatrixRow[] = [];
    for (const color of colorList) {
      for (const inseam of inseamList) {
        out.push({ key: rowKeyOf(color, inseam), color: color ?? null, rise: inseam ?? null });
      }
    }
    return out;
  }, [matrix, hasMultiInseam]);

  // Per-cell on-hand hint (≥ 0), keyed to grid cells = matrixCellKey(rowKey,size).
  const onHand = useMemo(() => {
    const m: Record<string, number> = {};
    for (const row of rows) {
      const [color, inseam] = row.key.split("|");
      for (const sz of sizes) {
        const sku = skuByCell.get(cellKey(color || null, sz, inseam || null));
        if (sku && sku.on_hand_qty != null) m[matrixCellKey(row.key, sz)] = Math.max(0, Number(sku.on_hand_qty) || 0);
      }
    }
    return m;
  }, [rows, sizes, skuByCell]);

  const enteredCount = useMemo(
    () => Object.values(qtyMap).filter((v) => Number.isFinite(v) && v > 0).length,
    [qtyMap],
  );
  const totalUnits = useMemo(
    () => Object.values(qtyMap).reduce((s, n) => s + (n > 0 ? n : 0), 0),
    [qtyMap],
  );

  function setQty(rowKey: string, size: string, n: number) {
    const key = matrixCellKey(rowKey, size);
    setQtyMap((p) => {
      const next = { ...p };
      if (Number.isFinite(n) && n > 0) next[key] = n; else delete next[key];
      return next;
    });
  }

  async function createAll() {
    setErr(null);
    // A transfer reason is REQUIRED — block + warn via the factored warn UI.
    if (!reason.trim()) { await confirmDialog("Please select a Transfer Reason before creating transfers."); return; }
    if (!matrix) { setErr("Pick a style first"); return; }
    if (!fromLoc.trim()) { setErr("From location is required"); return; }
    if (!toLoc.trim()) { setErr("To location is required"); return; }
    if (fromLoc.trim() === toLoc.trim()) { setErr("To location must differ from From location"); return; }
    const cells = Object.entries(qtyMap).filter(([, v]) => Number.isFinite(v) && v > 0);
    if (cells.length === 0) { setErr("No cells with a qty. Type a transfer qty into a cell."); return; }

    setSaving(true);
    const actorUid = getCachedAuthUserId();
    let created = 0;
    const failures: string[] = [];
    try {
      for (const [k, qty] of cells) {
        // k = `${rowKey}__${size}` = `${color}|${inseam}__${size}`.
        const [rowKey, size] = k.split("__");
        const [color, inseam] = rowKey.split("|");
        setProgress(`Resolving SKU ${created + failures.length + 1}/${cells.length}…`);
        // Reuse the existing SKU id when we already have it; else resolve/create.
        let itemId = skuByCell.get(cellKey(color || null, size, inseam || null))?.id;
        if (!itemId) {
          const rs = await fetch(`/api/internal/style-matrix/resolve-sku`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              style_id: matrix.style.id,
              style_code: matrix.style.style_code,
              color: color || null,
              size,
              inseam: inseam || null,
            }),
          });
          const out = await rs.json().catch(() => ({}));
          if (!rs.ok || !out.id) { failures.push(`${color || "—"}/${size}: resolve-sku ${out.error || rs.status}`); continue; }
          itemId = out.id as string;
        }
        // Create one transfer row via the create endpoint.
        const combinedNotes = [reason.trim(), notes.trim()].filter(Boolean).join(" — ");
        const body: Record<string, unknown> = {
          item_id: itemId,
          qty,
          from_location: fromLoc.trim(),
          to_location: toLoc.trim(),
        };
        if (combinedNotes) body.notes = combinedNotes;
        if (actorUid) body.created_by_user_id = actorUid;
        const rc = await fetch(`/api/internal/inventory-transfers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!rc.ok) {
          const e = await rc.json().catch(() => ({}));
          failures.push(`${color || "—"}/${size}: ${e.error || rc.status}`);
          continue;
        }
        created += 1;
      }
    } finally {
      setSaving(false);
      setProgress(null);
    }

    if (failures.length > 0) {
      notify(`Created ${created} transfer(s); ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`, created > 0 ? "info" : "error");
      if (created > 0) onSaved();
    } else {
      notify(`Created ${created} transfer(s) for style ${matrix.style.style_code}.`, "success");
      onSaved();
    }
  }

  const styleSelectOpts = useMemo(
    () => styleOpts.map((s) => ({
      value: s.id,
      label: s.style_name ? `${s.style_code} — ${s.style_name}` : s.style_code,
      searchHaystack: `${s.style_code} ${s.style_name ?? ""}`,
    })),
    [styleOpts],
  );

  return (
    <div style={modalBg} onClick={onClose}>
      {/* Item 2 — wide enough to show the full color × size grid + Grand Total for
          the largest matrix, with a little breathing room each side; the grid wraps
          in a horizontal-scroll area so an extra-wide size run never gets clipped. */}
      <div style={{ ...modalCard, width: "min(1400px, 97vw)" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Matrix Inventory Transfer</h2>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          Pick a FROM + TO location once, choose a style, then type a transfer qty into each cell.
          One transfer row is created per non-zero cell. The faint number above each cell is the current on-hand.
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>From warehouse</label>
            <SearchableSelect value={fromLoc || null} onChange={(v) => setFromLoc(v || "")}
              options={whOpts} placeholder="Search warehouse…" inputStyle={inputStyle} />
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>To warehouse</label>
            <SearchableSelect value={toLoc || null} onChange={(v) => setToLoc(v || "")}
              options={whOpts} placeholder="Search warehouse…" inputStyle={inputStyle} />
          </div>
          <div style={{ flex: "2 1 320px" }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Notes (optional)</label>
            <input
              style={inputStyle}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Applies to every transfer in this batch"
            />
          </div>
        </div>

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Transfer Reason *</label>
        <div style={{ marginBottom: 12 }}>
          <TransferReasonPicker
            reasons={reasons}
            value={reason}
            onChange={setReason}
            onAddNew={(q) => { if (!isAdmin) { notify("Only admins can add transfer reasons. Ask an admin, or pick an existing reason.", "error"); return; } void addReason(q).then((name) => { if (name) setReason(name); }); }}
          />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
            Required — applies to every transfer in this batch. Curate the list in the Transfer Reasons master, or type one and choose "Add new".
          </div>
        </div>

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Style</label>
        <div style={{ marginBottom: 12 }}>
          <SearchableSelect
            value={styleId || null}
            onChange={(v) => setStyleId(v)}
            options={styleSelectOpts}
            placeholder="Search by style number or name…"
            emptyText="No styles match"
          />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
            Picking a style loads its color × size grid below.
          </div>
        </div>

        {matrixLoading && (
          <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>Loading matrix…</div>
        )}

        {matrix && !matrixLoading && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: C.textSub, marginBottom: 6 }}>
              {matrix.colors.length} color(s) × {matrix.sizes.length} size(s)
              {hasMultiInseam ? ` × ${matrix.inseams.length} inseam(s)` : ""} ·{" "}
              <span style={{ color: C.warn }}>{enteredCount} cell(s) · {totalUnits} units</span> ·{" "}
              <span style={{ color: C.textMuted }}>type a qty to transfer; faint number is on-hand</span>
            </div>
            {sizes.length === 0 ? (
              <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>
                This style has no sized SKUs or size scale yet — use single-variant "+ Add" instead.
              </div>
            ) : (
              <div style={{ overflowX: "auto", paddingBottom: 4 }}>
                <EditableSizeMatrix
                  rows={rows}
                  sizes={sizes}
                  showRise={hasMultiInseam}
                  riseLabel="Inseam"
                  qty={qtyMap}
                  onQtyChange={setQty}
                  onHand={onHand}
                />
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", position: "sticky", bottom: 0, background: C.card, paddingTop: 12, marginTop: 8, borderTop: `1px solid ${C.cardBdr}` }}>
          {progress && <span style={{ color: C.textMuted, fontSize: 12, marginRight: "auto" }}>{progress}</span>}
          <button type="button" style={btnSecondary} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" style={btnPrimary} onClick={() => void createAll()} disabled={saving || enteredCount === 0}>
            {saving ? "Creating…" : `Create ${enteredCount} transfer(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// EditTransferModal — PATCH qty / notes / transfer_date on an unposted row.
// (#1024)
// ─────────────────────────────────────────────────────────────────────────
function EditTransferModal({
  row, onClose, onSaved,
}: {
  row: InventoryTransfer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [qty, setQty] = useState(String(row.qty));
  const [notes, setNotes] = useState(row.notes || "");
  const [transferDate, setTransferDate] = useState(
    row.transfer_date ? String(row.transfer_date).slice(0, 10) : new Date().toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const qtyNum = parseInt(qty, 10);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) throw new Error("Qty must be a positive integer");
      const r = await fetch(`/api/internal/inventory-transfers/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qty: qtyNum, notes: notes.trim() || null, transfer_date: transferDate }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Transfer updated.", "success");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={modalBg} onClick={onClose}>
      <div style={{ ...modalCard, width: "min(500px, 95vw)" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>Edit Transfer</h2>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
          Only <strong>Qty</strong>, <strong>Transfer Date</strong>, and <strong>Notes</strong> can be changed.
          Delete and recreate to change the SKU or locations.
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Qty</label>
        <input
          style={{ ...inputStyle, marginBottom: 12, width: 120 }}
          type="number"
          min={1}
          step={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Transfer Date</label>
        <input
          type="date"
          style={{ ...inputStyle, marginBottom: 12 }}
          value={transferDate}
          onChange={(e) => setTransferDate(e.target.value)}
        />

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Notes (optional)</label>
        <textarea
          style={{ ...inputStyle, marginBottom: 12, minHeight: 50, resize: "vertical" }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" style={btnSecondary} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" style={btnPrimary} onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
