// src/tanda/InternalInventoryTransfers.tsx
//
// Tangerine P3 Chunk 7 - M37 Inventory Transfers (skeleton).
//
// Read-only list panel. The "Add" button is disabled with a tooltip pointing
// at when the full multi-warehouse transfer UX lands. The schema is in place
// for forward compatibility; this panel renders rows once they exist.

import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

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
  primary: "#3B82F6", success: "#10B981", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnPrimaryDisabled: React.CSSProperties = {
  ...btnPrimary, background: C.cardBdr, color: C.textMuted, cursor: "not-allowed",
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

const ADD_DISABLED_TOOLTIP =
  "Multi-warehouse + transfer creation lands when M37 full UX ships. Schema exists for forward compatibility.";

export default function InternalInventoryTransfers() {
  const [rows, setRows] = useState<InventoryTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [itemId, setItemId] = useState("");
  const [fromLoc, setFromLoc] = useState("");
  const [toLoc, setToLoc] = useState("");

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    INV_XFER_TABLE_KEY,
    INV_XFER_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

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
          Location-to-location moves. Read-only at this skeleton stage.
        </span>
        <button
          type="button"
          style={{ ...btnPrimaryDisabled, marginLeft: "auto" }}
          title={ADD_DISABLED_TOOLTIP}
          aria-disabled="true"
          disabled
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
              <th style={th} hidden={!isVisible("style")}>Style</th>
              <th style={th} hidden={!isVisible("qty")}>Qty</th>
              <th style={th} hidden={!isVisible("from")}>From</th>
              <th style={th} hidden={!isVisible("to")}>To</th>
              <th style={th} hidden={!isVisible("date")}>Date</th>
              <th style={th} hidden={!isVisible("notes")}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={6}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={6}>
                <span style={{ color: C.textMuted }}>
                  No transfers logged yet. Schema is in place for forward compatibility.
                </span>
              </td></tr>
            )}
            {rows.map((t) => (
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
    </div>
  );
}
