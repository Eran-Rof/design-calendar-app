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
import { notify } from "../shared/ui/warn";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";

// Universal column-visibility registry for this panel (operator ask #1).
const INV_XFER_TABLE_KEY = "tangerine:inventorytransfers:columns";
const INV_XFER_COLUMNS: ColumnDef[] = [
  { key: "style", label: "Style" },
  { key: "qty",   label: "Qty" },
  { key: "from",  label: "From" },
  { key: "to",    label: "To" },
  { key: "date",  label: "Date" },
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
  padding: 24, width: 560, maxWidth: "90vw", maxHeight: "90vh", overflow: "auto",
};

export default function InternalInventoryTransfers() {
  const [rows, setRows] = useState<InventoryTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [itemId, setItemId] = useState("");
  const [fromLoc, setFromLoc] = useState("");
  const [toLoc, setToLoc] = useState("");

  // Entry modals.
  const [addOpen, setAddOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    INV_XFER_TABLE_KEY,
    INV_XFER_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:inventorytransfers:sort",
    accessors: {
      style: (t) => t.item_id,
      from: (t) => t.from_location,
      to: (t) => t.to_location,
      date: (t) => t.transfer_date,
    },
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (itemId.trim()) params.set("item_id", itemId.trim());
      if (fromLoc.trim()) params.set("from_location", fromLoc.trim());
      if (toLoc.trim()) params.set("to_location", toLoc.trim());
      const r = await fetch(`/api/internal/inventory-transfers?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [itemId, fromLoc, toLoc]);

  function fmtDate(iso: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Inventory Transfers</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Location-to-location moves. Use the size grid (Matrix transfer) or a single variant.
        </span>
        <button
          type="button"
          style={{ ...btnSecondary, marginLeft: "auto" }}
          onClick={() => setMatrixOpen(true)}
        >
          ▦ Matrix transfer
        </button>
        <button
          type="button"
          style={btnPrimary}
          onClick={() => setAddOpen(true)}
        >
          + Add
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input
          style={{ ...inputStyle, width: 320 }}
          placeholder="Item ID (uuid)"
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
        />
        <input
          style={{ ...inputStyle, width: 200 }}
          placeholder="From location"
          value={fromLoc}
          onChange={(e) => setFromLoc(e.target.value)}
        />
        <input
          style={{ ...inputStyle, width: 200 }}
          placeholder="To location"
          value={toLoc}
          onChange={(e) => setToLoc(e.target.value)}
        />
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

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortableTh label="Style" sortKey="style" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("style")} />
              <SortableTh label="Qty" sortKey="qty" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("qty")} />
              <SortableTh label="From" sortKey="from" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("from")} />
              <SortableTh label="To" sortKey="to" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("to")} />
              <SortableTh label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("date")} />
              <SortableTh label="Notes" sortKey="notes" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("notes")} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={6}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={6}>
                <span style={{ color: C.textMuted }}>
                  No transfers logged yet. Use "▦ Matrix transfer" or "+ Add".
                </span>
              </td></tr>
            )}
            {sorted.map((t) => (
              <tr key={t.id}>
                <td style={{ ...td, fontFamily: "monospace", color: C.textSub }} hidden={!isVisible("style")}>{t.item_id}</td>
                <td style={td} hidden={!isVisible("qty")}>{t.qty}</td>
                <td style={td} hidden={!isVisible("from")}>{t.from_location}</td>
                <td style={td} hidden={!isVisible("to")}>{t.to_location}</td>
                <td style={td} hidden={!isVisible("date")}>{fmtDate(t.transfer_date)}</td>
                <td style={{ ...td, color: C.textSub }} hidden={!isVisible("notes")}>{t.notes || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <SingleTransferModal
          defaultFrom={fromLoc.trim()}
          defaultTo={toLoc.trim()}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}

      {matrixOpen && (
        <MatrixTransferModal
          defaultFrom={fromLoc.trim()}
          defaultTo={toLoc.trim()}
          onClose={() => setMatrixOpen(false)}
          onSaved={() => { setMatrixOpen(false); void load(); }}
        />
      )}
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
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    const qtyNum = Number(qty);
    if (!itemId.trim()) { setErr("Item UUID is required"); return; }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) { setErr("Qty must be a positive number"); return; }
    if (!fromLoc.trim()) { setErr("From location is required"); return; }
    if (!toLoc.trim()) { setErr("To location is required"); return; }
    if (fromLoc.trim() === toLoc.trim()) { setErr("To location must differ from From location"); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        item_id: itemId.trim(),
        qty: qtyNum,
        from_location: fromLoc.trim(),
        to_location: toLoc.trim(),
      };
      if (notes.trim()) body.notes = notes.trim();
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

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Item UUID</label>
        <input
          style={{ ...inputStyle, marginBottom: 12 }}
          placeholder="Paste an ip_item_master SKU UUID"
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
        />

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
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>From location</label>
            <input style={inputStyle} value={fromLoc} onChange={(e) => setFromLoc(e.target.value)} placeholder="e.g. MAIN" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>To location</label>
            <input style={inputStyle} value={toLoc} onChange={(e) => setToLoc(e.target.value)} placeholder="e.g. RETAIL" />
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
  const [notes, setNotes] = useState("");

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

  // Load up to 200 styles for the picker (SearchableSelect filters locally).
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/internal/style-master?limit=200`);
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
        const body: Record<string, unknown> = {
          item_id: itemId,
          qty,
          from_location: fromLoc.trim(),
          to_location: toLoc.trim(),
        };
        if (notes.trim()) body.notes = notes.trim();
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
      <div style={{ ...modalCard, width: 820 }} onClick={(e) => e.stopPropagation()}>
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
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>From location</label>
            <input style={inputStyle} value={fromLoc} onChange={(e) => setFromLoc(e.target.value)} placeholder="e.g. MAIN" />
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>To location</label>
            <input style={inputStyle} value={toLoc} onChange={(e) => setToLoc(e.target.value)} placeholder="e.g. RETAIL" />
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
              <EditableSizeMatrix
                rows={rows}
                sizes={sizes}
                showRise={hasMultiInseam}
                riseLabel="Inseam"
                qty={qtyMap}
                onQtyChange={setQty}
                onHand={onHand}
              />
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
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
