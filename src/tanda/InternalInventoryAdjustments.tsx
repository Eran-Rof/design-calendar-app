// src/tanda/InternalInventoryAdjustments.tsx
//
// Tangerine P3 Chunk 5 - M37 Inventory Adjustments admin panel.
//
// List + filter (type / item / date range / posted status) + Add modal
// (positive => layer creation; negative => FIFO consume) + Edit modal for
// unposted + Post button for unposted. Mirrors the dark-theme aesthetic of
// the other Internal* panels.

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import SearchableSelect from "./components/SearchableSelect";
import { EditableSizeMatrix, matrixCellKey } from "../shared/matrix";
import type { EditableMatrixRow } from "../shared/matrix";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

// Universal column-visibility registry for this panel (operator ask #1).
const INV_ADJ_TABLE_KEY = "tangerine:inventoryadjustments:columns";
const INV_ADJ_COLUMNS: ColumnDef[] = [
  { key: "when",    label: "When" },
  { key: "by",      label: "By" },
  { key: "type",    label: "Type" },
  { key: "style",   label: "Style" },
  { key: "qty",     label: "Qty" },
  { key: "cost",    label: "Cost (cents)" },
  { key: "counter", label: "Counter Account" },
  { key: "reason",  label: "Reason" },
  { key: "status",  label: "Status" },
];

type Adjustment = {
  id: string;
  entity_id: string;
  item_id: string;
  adjustment_type: string;
  qty_delta: number;
  unit_cost_cents: number | null;
  reason: string;
  gl_account_id: string;
  posted_je_id: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  created_by_name?: string | null;
};

type Item = { id: string; sku_code: string | null; description?: string | null };
type GlAccount = { id: string; code: string; name: string; is_postable: boolean; account_type?: string };
type AdjReason = { id: string; code: string; name: string };

// adjustment_type is now sourced from the configurable Adjustment Type master
// (adjustment_type_master). A type is a CATEGORY / reason for grouping only — it
// does NOT drive the increase/decrease FIFO accounting (that's the qty sign +
// unit cost). The stored value is the chosen type NAME (free text, no FK).
type AdjType = { id: string; code: string; name: string; is_active: boolean };
type AdjustmentType = string;

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
const btnDanger: React.CSSProperties = {
  background: "transparent", color: C.danger, border: `1px solid ${C.danger}`,
  padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
};
const btnSuccess: React.CSSProperties = {
  background: C.success, color: "white", border: 0, padding: "4px 10px",
  borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600,
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


function fmtMoneyCents(cents: number | null): string {
  if (cents == null) return "-";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

export default function InternalInventoryAdjustments() {
  const [rows, setRows] = useState<Adjustment[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);
  const [adjTypes, setAdjTypes] = useState<AdjType[]>([]);
  const [adjustmentReasons, setAdjustmentReasons] = useState<AdjReason[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Filters
  const [filterType, setFilterType] = useState<string>("");
  const [filterItem, setFilterItem] = useState("");
  const [filterUser, setFilterUser] = useState(""); // item 4 — who created the adjustment
  const [filterPosted, setFilterPosted] = useState<"" | "true" | "false">("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  // Item 4 — distinct creators present in the loaded rows → user-filter options.
  const userOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.created_by_user_id) m.set(r.created_by_user_id, r.created_by_name || r.created_by_user_id.slice(0, 8));
    return [{ value: "", label: "All users" }, ...[...m].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
  }, [rows]);

  // Add flow. "+ Add" is the single entry point; it first opens a small chooser
  // (Single variant vs Matrix), which then opens the corresponding modal.
  const [addChooserOpen, setAddChooserOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<Adjustment | null>(null);
  const [matrixModalOpen, setMatrixModalOpen] = useState(false);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    INV_ADJ_TABLE_KEY,
    INV_ADJ_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (filterType) params.set("adjustment_type", filterType);
      if (filterPosted) params.set("posted", filterPosted);
      if (filterFrom) params.set("from", filterFrom);
      if (filterTo) params.set("to", filterTo);
      const r = await fetch(`/api/internal/inventory-adjustments?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [filterType, filterPosted, filterFrom, filterTo]);

  // Side-load items (for SKU display + picker) + gl_accounts (for picker).
  useEffect(() => {
    (async () => {
      try {
        const itemsRes = await fetch(`/api/internal/style-master?limit=10000`);
        if (itemsRes.ok) {
          const data = await itemsRes.json();
          // style-master shape: depends on handler; fall back to flatMap-friendly
          const list: Item[] = Array.isArray(data)
            ? data.map((s: any) => ({ id: s.id, sku_code: s.sku_code || s.style_code || null, description: s.description }))
            : [];
          setItems(list);
        }
      } catch { /* non-fatal */ }
      try {
        const glRes = await fetch(`/api/internal/gl-accounts`);
        if (glRes.ok) setGlAccounts(await glRes.json());
      } catch { /* non-fatal */ }
      try {
        // Adjustment Type master — drives the type picklist + filter (active only).
        const atRes = await fetch(`/api/internal/adjustment-types`);
        if (atRes.ok) {
          const data = await atRes.json();
          if (Array.isArray(data)) setAdjTypes(data as AdjType[]);
        }
      } catch { /* non-fatal */ }
      try {
        // Adjustment Reason master — drives the reason picker in add/edit modals.
        const arRes = await fetch(`/api/internal/adjustment-reasons`);
        if (arRes.ok) {
          const data = await arRes.json();
          if (Array.isArray(data)) setAdjustmentReasons(data as AdjReason[]);
        }
      } catch { /* non-fatal */ }
    })();
  }, []);

  const itemById = useMemo(() => {
    const m = new Map<string, Item>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);
  const glById = useMemo(() => {
    const m = new Map<string, GlAccount>();
    for (const g of glAccounts) m.set(g.id, g);
    return m;
  }, [glAccounts]);

  function itemLabel(id: string): string {
    const it = itemById.get(id);
    if (it) return it.sku_code || "—";
    return "—";
  }
  function glLabel(id: string): string {
    const g = glById.get(id);
    if (g) return `${g.code} - ${g.name}`;
    return "—";
  }

  async function handleDelete(row: Adjustment) {
    if (!(await confirmDialog(`Delete adjustment for ${itemLabel(row.item_id)}? Only unposted rows can be deleted.`))) return;
    const r = await fetch(`/api/internal/inventory-adjustments/${row.id}`, { method: "DELETE" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      notify(`Delete failed: ${e.error || r.status}`, "error");
      return;
    }
    void load();
  }

  async function handlePost(row: Adjustment) {
    if (!(await confirmDialog(`Post adjustment for ${itemLabel(row.item_id)}? This will emit a journal entry${row.qty_delta < 0 ? " and consume FIFO layers" : " and create a FIFO layer"}.`))) return;
    const actor_user_id = getCachedAuthUserId();
    const r = await fetch(`/api/internal/inventory-adjustments/${row.id}/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_user_id }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) {
      notify(`Post failed: ${out.error || r.status}`, "error");
      return;
    }
    if (out.requires_approval) {
      notify(`Approval required. The adjustment stays draft until the request is decided.`, "info");
    } else {
      notify(`Posted.`, "success");
    }
    void load();
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Inventory Adjustments</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Damage / shrinkage / found / correction / write-off / return-to-vendor. Positive creates a FIFO layer; negative consumes via FIFO.
        </span>
        <button
          type="button"
          style={{ ...btnPrimary, marginLeft: "auto" }}
          onClick={() => { setEditingRow(null); setAddChooserOpen(true); }}
        >
          + Add
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ width: 180 }}>
          <SearchableSelect
            value={filterType || null}
            onChange={(v) => setFilterType(v)}
            options={[{ value: "", label: "All types" }, ...adjTypes.map((t) => ({ value: t.name, label: t.name }))]}
            placeholder="All types"
            inputStyle={inputStyle}
          />
        </div>
        <input
          style={{ ...inputStyle, width: 280 }}
          placeholder="Filter by SKU…"
          value={filterItem}
          onChange={(e) => setFilterItem(e.target.value)}
        />
        <div style={{ width: 180 }} title="Filter by who created the adjustment">
          <SearchableSelect
            value={filterUser || null}
            onChange={(v) => setFilterUser(v || "")}
            options={userOptions}
            placeholder="All users"
            inputStyle={inputStyle}
          />
        </div>
        <div style={{ width: 140 }}>
          <SearchableSelect
            value={filterPosted || null}
            onChange={(v) => setFilterPosted(v as "" | "true" | "false")}
            options={[
              { value: "", label: "All statuses" },
              { value: "false", label: "Draft (unposted)" },
              { value: "true", label: "Posted" },
            ]}
            placeholder="All statuses"
            inputStyle={inputStyle}
          />
        </div>
        <input
          type="date"
          style={{ ...inputStyle, width: 140 }}
          value={filterFrom}
          onChange={(e) => setFilterFrom(e.target.value)}
          placeholder="From"
        />
        <input
          type="date"
          style={{ ...inputStyle, width: 140 }}
          value={filterTo}
          onChange={(e) => setFilterTo(e.target.value)}
          placeholder="To"
        />
        <DateRangePresets variant="dropdown"
          from={filterFrom}
          to={filterTo}
          onChange={(f, t) => { setFilterFrom(f); setFilterTo(t); }}
        />
        <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          <TablePrefsButton
            tableKey={INV_ADJ_TABLE_KEY}
            columns={INV_ADJ_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
          />
          <ExportButton
            rows={rows as unknown as Array<Record<string, unknown>>}
            filename="inventory-adjustments"
            sheetName="Inventory Adjustments"
            columns={[
              { key: "created_at",       header: "When",           format: "datetime" },
              { key: "adjustment_type",  header: "Type" },
              { key: "item_id",          header: "Item ID" },
              { key: "qty_delta",        header: "Qty",            format: "number" },
              { key: "unit_cost_cents",  header: "Unit Cost",      format: "currency_cents" },
              { key: "gl_account_id",    header: "Counter Account" },
              { key: "reason",           header: "Reason" },
              { key: "posted_je_id",     header: "Posted JE" },
              { key: "posted_at",        header: "Posted At",      format: "datetime" },
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
              <th style={th} hidden={!isVisible("when")}>When</th>
              <th style={th} hidden={!isVisible("by")}>By</th>
              <th style={th} hidden={!isVisible("type")}>Type</th>
              <th style={th} hidden={!isVisible("style")}>Style</th>
              <th style={th} hidden={!isVisible("qty")}>Qty</th>
              <th style={th} hidden={!isVisible("cost")}>Cost (cents)</th>
              <th style={th} hidden={!isVisible("counter")}>Counter Account</th>
              <th style={th} hidden={!isVisible("reason")}>Reason</th>
              <th style={th} hidden={!isVisible("status")}>Status</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={10}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={10}>
                <span style={{ color: C.textMuted }}>No adjustments. Use "+ Add" above.</span>
              </td></tr>
            )}
            {rows.filter((row) => {
              const fq = filterItem.trim().toLowerCase();
              if (fq && !itemLabel(row.item_id).toLowerCase().includes(fq)) return false;
              if (filterUser && (row.created_by_user_id || "") !== filterUser) return false; // item 4
              return true;
            }).map((row) => {
              const isPositive = row.qty_delta > 0;
              return (
                <tr key={row.id}>
                  <td style={{ ...td, whiteSpace: "nowrap" }} hidden={!isVisible("when")}>{row.created_at ? new Date(row.created_at).toLocaleString("en-US") : "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("by")}>{row.created_by_name || "—"}</td>
                  <td style={td} hidden={!isVisible("type")}>{row.adjustment_type}</td>
                  <td style={{ ...td, fontFamily: "monospace", color: C.textSub }} hidden={!isVisible("style")}>{itemLabel(row.item_id)}</td>
                  <td style={{ ...td, color: isPositive ? C.success : C.danger, fontFamily: "monospace" }} hidden={!isVisible("qty")}>
                    {isPositive ? "+" : ""}{row.qty_delta}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace" }} hidden={!isVisible("cost")}>{fmtMoneyCents(row.unit_cost_cents)}</td>
                  <td style={{ ...td, fontFamily: "monospace", color: C.textSub }} hidden={!isVisible("counter")}>{glLabel(row.gl_account_id)}</td>
                  <td style={{ ...td, color: C.textSub, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} hidden={!isVisible("reason")}>{row.reason}</td>
                  <td style={td} hidden={!isVisible("status")}>
                    {row.posted_je_id
                      ? <span style={{ color: C.success }}>POSTED</span>
                      : <span style={{ color: C.warn }}>DRAFT</span>}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {!row.posted_je_id && (
                      <>
                        <button style={btnSecondary} onClick={() => { setEditingRow(row); setModalOpen(true); }}>Edit</button>
                        {" "}
                        <button style={btnSuccess} onClick={() => void handlePost(row)}>Post</button>
                        {" "}
                        <button style={btnDanger} onClick={() => void handleDelete(row)}>Del</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {addChooserOpen && (
        <AddModeChooser
          onPick={(mode) => {
            setAddChooserOpen(false);
            if (mode === "single") setModalOpen(true);
            else setMatrixModalOpen(true);
          }}
          onClose={() => setAddChooserOpen(false)}
        />
      )}

      {modalOpen && (
        <AdjustmentModal
          items={items}
          adjTypes={adjTypes}
          adjustmentReasons={adjustmentReasons}
          existing={editingRow}
          onClose={() => { setModalOpen(false); setEditingRow(null); }}
          onSaved={() => { setModalOpen(false); setEditingRow(null); void load(); }}
        />
      )}

      {matrixModalOpen && (
        <MatrixAdjustmentModal
          adjTypes={adjTypes}
          adjustmentReasons={adjustmentReasons}
          onClose={() => setMatrixModalOpen(false)}
          onSaved={() => { setMatrixModalOpen(false); void load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Add-mode chooser — the single "+ Add" entry point. The operator picks
// whether to add a Single variant adjustment or a Matrix (color × size) batch.
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
      <div style={{ ...modalCard, width: "min(480px, 95vw)" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>New Inventory Adjustment</h2>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          Choose how to enter this adjustment.
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" style={tile} onClick={() => onPick("single")}>
            <div style={{ fontSize: 26, marginBottom: 6 }}>＋</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Single variant</div>
            <div style={{ fontSize: 11, color: C.textMuted }}>One SKU, one signed qty.</div>
          </button>
          <button type="button" style={tile} onClick={() => onPick("matrix")}>
            <div style={{ fontSize: 26, marginBottom: 6 }}>▦</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Matrix</div>
            <div style={{ fontSize: 11, color: C.textMuted }}>Color × size grid; one draft per non-zero cell.</div>
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" style={btnSecondary} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AdjustmentModal({
  items, adjTypes, adjustmentReasons, existing, onClose, onSaved,
}: {
  items: Item[];
  adjTypes: AdjType[];
  adjustmentReasons: AdjReason[];
  existing: Adjustment | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [itemId, setItemId] = useState(existing?.item_id || "");
  const [itemQuery, setItemQuery] = useState("");
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>(
    existing?.adjustment_type || adjTypes[0]?.name || ""
  );
  const [unitCostCents, setUnitCostCents] = useState<string>(
    existing?.unit_cost_cents != null ? String(existing.unit_cost_cents) : ""
  );
  const [reason, setReason] = useState(existing?.reason || "");
  // P15 — for a positive (found/correction-up) adjustment, which brand pool the
  // new layer lands in (WS/EC). Single-pool brands ignore it.
  const [receivingChannel, setReceivingChannel] = useState<"WS" | "EC">("WS");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Item 7 — explicit direction (add inventory / reduce inventory) + a positive
  // magnitude, instead of a raw signed number, with a confirm before saving.
  const [direction, setDirection] = useState<"add" | "reduce">(
    existing != null ? (existing.qty_delta >= 0 ? "add" : "reduce") : "reduce",
  );
  const [magnitude, setMagnitude] = useState<string>(
    existing != null ? String(Math.abs(existing.qty_delta)) : "1",
  );
  const mag = Math.abs(Number(magnitude));
  const qtyNum = Number.isFinite(mag) ? (direction === "add" ? mag : -mag) : NaN;
  const isPositive = Number.isFinite(qtyNum) && qtyNum > 0;
  const isNegative = Number.isFinite(qtyNum) && qtyNum < 0;

  // Item 1 — add an adjustment reason on the fly (admins only; others get a warn).
  const isAdmin = !!getCachedAuthUserId();
  const [extraReasons, setExtraReasons] = useState<AdjReason[]>([]);
  const reasonOptions = useMemo(() => [...extraReasons, ...adjustmentReasons], [extraReasons, adjustmentReasons]);
  async function addReasonOnTheFly(q: string) {
    const name = q.trim();
    if (!name) return;
    if (!isAdmin) { notify("Only admins can add adjustment reasons. Ask an admin, or pick an existing reason.", "error"); return; }
    try {
      const r = await fetch("/api/internal/adjustment-reasons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const created = j as AdjReason;
      setExtraReasons((p) => [created, ...p]);
      setReason(created.name);
      notify(`Reason "${created.name}" added.`, "success");
    } catch (e) { notify(`Could not add reason: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }

  const itemMatches = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    if (!q) return items.slice(0, 20);
    return items.filter((it) =>
      (it.sku_code || "").toLowerCase().includes(q) ||
      (it.description || "").toLowerCase().includes(q),
    ).slice(0, 20);
  }, [items, itemQuery]);

  const selectedItem = items.find((it) => it.id === itemId) || null;

  async function save() {
    setErr(null);
    setSaving(true);
    try {
      // For edits, only send the fields the [id] handler accepts.
      let url: string;
      let method: "POST" | "PATCH";
      let body: any;

      if (isEdit) {
        url = `/api/internal/inventory-adjustments/${existing!.id}`;
        method = "PATCH";
        body = {
          reason,
          qty_delta: qtyNum,
        };
        if (isPositive) {
          body.unit_cost_cents = Number(unitCostCents);
        } else {
          body.unit_cost_cents = null;
        }
      } else {
        // An adjustment TYPE (or reason) is REQUIRED — block + warn via the
        // factored warn UI before any POST (#985).
        if (!adjustmentType.trim()) {
          notify("Pick an Adjustment Type before saving (add types in the Adjustment Types master).", "error");
          setSaving(false);
          return;
        }
        if (!itemId) throw new Error("Pick an item first");
        // Item 6 — reason required: warn + block (don't silently proceed).
        if (!reason.trim()) { notify("Pick an adjustment reason before saving.", "error"); setSaving(false); return; }
        if (!Number.isFinite(qtyNum) || qtyNum === 0) throw new Error("Enter a quantity greater than 0");
        if (isPositive && !unitCostCents) throw new Error("Unit cost is required when adding inventory");

        // Item 7 — confirm the direction before creating the adjustment. Posting it
        // later debits/credits Inventory and the Inventory Adjustments account.
        const ok = await confirmDialog(
          `This will ${isPositive ? "ADD" : "SUBTRACT"} ${mag} unit(s) ${isPositive ? "to" : "from"} on-hand for ${selectedItem?.sku_code || "this item"}.\n\nWhen you Post it, it books a journal entry — ${isPositive ? "debit Inventory / credit Inventory Adjustments" : "credit Inventory / debit Inventory Adjustments"}.\n\nContinue?`,
        );
        if (!ok) { setSaving(false); return; }

        url = `/api/internal/inventory-adjustments`;
        method = "POST";
        body = {
          item_id: itemId,
          adjustment_type: adjustmentType,
          qty_delta: qtyNum,
          reason,
          // gl_account_id is resolved server-side; not sent from client.
        };
        if (isPositive) { body.unit_cost_cents = Number(unitCostCents); body.receiving_channel = receivingChannel; }
        const actorUid = getCachedAuthUserId();
        if (actorUid) body.created_by_user_id = actorUid;
      }
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
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
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isEdit ? "Edit Inventory Adjustment" : "New Inventory Adjustment"}
        </h2>

        {err && (
          <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        {!isEdit && (
          <>
            <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: C.textMuted }}>Style</label>
            {selectedItem ? (
              <div style={{ marginBottom: 12 }}>
                <span style={{ fontFamily: "monospace", color: C.textSub }}>{selectedItem.sku_code || "—"}</span>{" "}
                <button type="button" style={{ ...btnSecondary, fontSize: 11 }} onClick={() => setItemId("")}>change</button>
              </div>
            ) : (
              <>
                <input
                  style={{ ...inputStyle, marginBottom: 6 }}
                  placeholder="Search by SKU or description..."
                  value={itemQuery}
                  onChange={(e) => setItemQuery(e.target.value)}
                />
                <div style={{ maxHeight: 200, overflow: "auto", border: `1px solid ${C.cardBdr}`, borderRadius: 4, marginBottom: 12 }}>
                  {itemMatches.length === 0 ? (
                    <div style={{ padding: 8, color: C.textMuted, fontSize: 12 }}>No matches. (Item list comes from style-master; type any UUID below to bypass.)</div>
                  ) : (
                    itemMatches.map((it) => (
                      <div
                        key={it.id}
                        style={{ padding: "6px 10px", cursor: "pointer", fontSize: 12, fontFamily: "monospace", color: C.textSub, borderBottom: `1px solid ${C.cardBdr}` }}
                        onClick={() => setItemId(it.id)}
                      >
                        {it.sku_code || "—"} - {it.description || ""}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: C.textMuted }}>Adjustment Type</label>
            <div style={{ marginBottom: 12 }}>
              <SearchableSelect
                value={adjustmentType || null}
                onChange={(v) => setAdjustmentType(v || "")}
                options={adjTypes.map((t) => ({
                  value: t.name,
                  label: t.name,
                  searchHaystack: `${t.code} ${t.name}`,
                }))}
                placeholder="Search adjustment type…"
                emptyText="No adjustment types — add some in the Adjustment Types master"
              />
            </div>
          </>
        )}

        {/* Item 7 — explicit direction: add (increase on-hand) vs reduce (decrease). */}
        <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: C.textMuted }}>Direction</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {([["add", "+ Add inventory (increase on-hand)"], ["reduce", "− Reduce inventory (decrease on-hand)"]] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setDirection(v)}
              style={{
                flex: 1, padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
                border: `1px solid ${direction === v ? (v === "add" ? C.success : C.warn) : C.cardBdr}`,
                background: direction === v ? (v === "add" ? "#0b2a1f" : "#3b2f0b") : "transparent",
                color: direction === v ? (v === "add" ? C.success : C.warn) : C.textSub,
              }}>{label}</button>
          ))}
        </div>
        <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: C.textMuted }}>Quantity (units)</label>
        <input
          style={{ ...inputStyle, marginBottom: 4 }}
          type="number"
          step="any"
          min="0"
          value={magnitude}
          onChange={(e) => setMagnitude(e.target.value)}
        />
        {Number.isFinite(qtyNum) && qtyNum !== 0 && (
          <div style={{ fontSize: 11, color: isPositive ? C.success : C.warn, marginBottom: 12 }}>
            {isPositive
              ? `This will ADD ${mag} unit(s) to on-hand — creates a new FIFO layer at the unit cost below.`
              : `This will SUBTRACT ${mag} unit(s) from on-hand — consumes via FIFO (cost is FIFO-derived at post).`}
          </div>
        )}

        {isPositive && (
          <>
            <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: C.textMuted }}>
              Unit cost (cents, integer)
            </label>
            <input
              style={{ ...inputStyle, marginBottom: 12 }}
              type="number"
              step="1"
              value={unitCostCents}
              onChange={(e) => setUnitCostCents(e.target.value)}
              placeholder="e.g. 1250 = $12.50/unit"
            />
            {!isEdit && (
              <>
                <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: C.textMuted }}>Receive into (brand pool)</label>
                <div style={{ marginBottom: 12 }}>
                  <SearchableSelect
                    value={receivingChannel}
                    onChange={(v) => setReceivingChannel(v as "WS" | "EC")}
                    options={[
                      { value: "WS", label: "Wholesale pool" },
                      { value: "EC", label: "Ecom pool" },
                    ]}
                    inputStyle={inputStyle}
                  />
                </div>
              </>
            )}
          </>
        )}

        <label style={{ display: "block", marginBottom: 8, fontSize: 12, color: C.textMuted }}>Reason{!reason.trim() && <span style={{ color: C.warn }}> *</span>}</label>
        <div style={{ marginBottom: 12 }}>
          <SearchableSelect
            value={reason || null}
            onChange={(v) => setReason(v || "")}
            options={reasonOptions.map((r) => ({
              value: r.name,
              label: r.name, // item 5 — name only (code stays searchable)
              searchHaystack: `${r.code} ${r.name}`,
            }))}
            placeholder="Search adjustment reason…"
            emptyText="No adjustment reasons — add some in the Adjustment Reason Master"
            onAddNew={(q) => void addReasonOnTheFly(q)}
            addNewLabel={(q) => `+ Add reason "${q.trim()}"`}
          />
          {/* Item 6 — a reason is required; warn inline until one is picked. */}
          {!isEdit && !reason.trim() && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>Pick a reason before saving.</div>}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" style={btnSecondary} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" style={btnPrimary} onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Create Draft"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MX-ADJ — Matrix inventory adjustments entry.
//
// Pick adjustment_type + counter GL account + reason ONCE (applies to the
// whole batch) + a style → fetch /api/internal/style-matrix → editable
// color × size (× inseam) grid. Each cell captures a signed qty_delta. On
// "Create adjustments" each non-zero cell resolves to a SKU id
// (resolve-sku) then POSTs one row to the EXISTING create endpoint.
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
// Per-row key (color × inseam) used by the grid + the unit-cost map.
function rowKeyOf(color: string | null, inseam: string | null): string {
  return `${color ?? ""}|${inseam ?? ""}`;
}

function MatrixAdjustmentModal({
  adjTypes, adjustmentReasons, onClose, onSaved,
}: {
  adjTypes: AdjType[];
  adjustmentReasons: AdjReason[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Batch-level fields (applied to every created adjustment).
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>(adjTypes[0]?.name || "");
  const [reason, setReason] = useState("");
  // Brand pool for POSITIVE (increase) cells only — mirrors the single "+ Add"
  // modal's receiving_channel. Single-pool brands ignore it server-side.
  const [receivingChannel, setReceivingChannel] = useState<"WS" | "EC">("WS");

  // Style picker.
  const [styleOpts, setStyleOpts] = useState<StyleOption[]>([]);
  const [styleId, setStyleId] = useState("");

  // Loaded matrix + per-cell deltas keyed by matrixCellKey(rowKey, size).
  const [matrix, setMatrix] = useState<StyleMatrixPayload | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [deltas, setDeltas] = useState<Record<string, number>>({});
  // Per-row unit COST in cents (free text), keyed by rowKey. Used only for
  // positive (increase) rows — the create endpoint requires unit_cost_cents
  // when qty_delta > 0.
  const [unitCostMap, setUnitCostMap] = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  // Load ALL styles for the picker (SearchableSelect filters locally) so the
  // operator can find any style — not just the first 200.
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

  // When a style is picked, fetch its matrix and reset deltas.
  useEffect(() => {
    if (!styleId) { setMatrix(null); setDeltas({}); setUnitCostMap({}); return; }
    setMatrixLoading(true);
    setErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        setMatrix(await r.json() as StyleMatrixPayload);
        setDeltas({});
        setUnitCostMap({});
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
    () => Object.values(deltas).filter((v) => Number.isFinite(v) && v !== 0).length,
    [deltas],
  );

  function setDelta(rowKey: string, size: string, n: number) {
    const key = matrixCellKey(rowKey, size);
    setDeltas((p) => {
      const next = { ...p };
      if (Number.isFinite(n) && n !== 0) next[key] = n; else delete next[key];
      return next;
    });
  }

  async function createAll() {
    setErr(null);
    // An adjustment TYPE (or reason) is REQUIRED — block + warn via the
    // factored warn UI before any POST (#985).
    if (!adjustmentType.trim()) { notify("Pick an Adjustment Type before creating adjustments (add types in the Adjustment Types master).", "error"); return; }
    if (!matrix) { setErr("Pick a style first"); return; }
    if (!reason.trim()) { await confirmDialog("Please select a Reason before creating adjustments."); return; }
    const cells = Object.entries(deltas).filter(([, v]) => Number.isFinite(v) && v !== 0);
    if (cells.length === 0) { setErr("No cells with a non-zero delta. Type a signed qty into a cell."); return; }

    // Positive (increase) cells create a FIFO layer and REQUIRE a per-unit cost,
    // captured in the row's "Unit cost (¢)" column. Block any positive cell whose
    // row has no valid cost before we POST anything.
    const missingCost: string[] = [];
    for (const [k, v] of cells) {
      if (v <= 0) continue;
      const [rowKey, size] = k.split("__");
      const [color] = rowKey.split("|");
      const raw = (unitCostMap[rowKey] ?? "").trim();
      const cents = Number(raw);
      if (!raw || !Number.isFinite(cents) || !Number.isInteger(cents) || cents < 0) {
        missingCost.push(`${color || "—"} / ${size}`);
      }
    }
    if (missingCost.length > 0) {
      setErr(
        `${missingCost.length} increase cell(s) need a unit cost. Enter the per-unit cost (in cents, e.g. 1250 = $12.50) in the "Unit cost (¢)" column for: ` +
        `${missingCost.slice(0, 5).join(", ")}${missingCost.length > 5 ? "…" : ""}.`,
      );
      return;
    }

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
          if (!rs.ok || !out.id) { failures.push(`${color}/${size}: resolve-sku ${out.error || rs.status}`); continue; }
          itemId = out.id as string;
        }
        // Create one adjustment via the EXISTING create endpoint. Negative →
        // FIFO-consume (no unit cost). Positive → create a FIFO layer with the
        // row's unit cost + brand pool — the same server path the single
        // "+ Add" modal uses for increases.
        const body: any = {
          item_id: itemId,
          adjustment_type: adjustmentType,
          qty_delta: qty,
          reason: reason.trim(),
          // gl_account_id is resolved server-side; not sent from client.
        };
        if (qty > 0) {
          body.unit_cost_cents = Number((unitCostMap[rowKey] ?? "").trim());
          body.receiving_channel = receivingChannel;
        }
        if (actorUid) body.created_by_user_id = actorUid;
        const rc = await fetch(`/api/internal/inventory-adjustments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!rc.ok) {
          const e = await rc.json().catch(() => ({}));
          failures.push(`${color}/${size}: ${e.error || rc.status}`);
          continue;
        }
        created += 1;
      }
    } finally {
      setSaving(false);
      setProgress(null);
    }

    if (failures.length > 0) {
      notify(`Created ${created} adjustment(s); ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`, created > 0 ? "info" : "error");
      if (created > 0) onSaved();
    } else {
      notify(`Created ${created} draft adjustment(s) for style ${matrix.style.style_code}.`, "success");
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
      <div style={{ ...modalCard, width: "min(820px, 95vw)" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Matrix Inventory Adjustment</h2>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          Pick type / reason once, choose a style, then type a signed qty into each cell:
          negative = decrease (FIFO-consume), positive = increase (creates a FIFO layer). One draft adjustment is
          created per non-zero cell. Increase rows must carry a per-unit <b>Unit cost (¢)</b> — use the column's
          "set all" header to stamp one cost across every row.
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Adjustment Type</label>
            <SearchableSelect
              value={adjustmentType || null}
              onChange={(v) => setAdjustmentType(v || "")}
              options={adjTypes.map((t) => ({
                value: t.name,
                label: t.name,
                searchHaystack: `${t.code} ${t.name}`,
              }))}
              placeholder="Search adjustment type…"
              emptyText="No adjustment types — add some in the Adjustment Types master"
            />
          </div>
          <div style={{ flex: "1 1 160px" }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Receive into (increase rows)</label>
            <SearchableSelect
              value={receivingChannel}
              onChange={(v) => setReceivingChannel(v as "WS" | "EC")}
              options={[
                { value: "WS", label: "Wholesale pool" },
                { value: "EC", label: "Ecom pool" },
              ]}
              inputStyle={inputStyle}
            />
          </div>
        </div>

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Reason</label>
        <div style={{ marginBottom: 12 }}>
          <SearchableSelect
            value={reason || null}
            onChange={(v) => setReason(v || "")}
            options={adjustmentReasons.map((r) => ({
              value: r.name,
              label: r.name, // item 5 — name only (code stays searchable)
              searchHaystack: `${r.code} ${r.name}`,
            }))}
            placeholder="Search adjustment reason…"
            emptyText="No adjustment reasons — add some in the Adjustment Reason Master"
          />
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
              <span style={{ color: C.warn }}>{enteredCount} cell(s) with a delta</span> ·{" "}
              <span style={{ color: C.textMuted }}>type −5 to decrease, 12 to increase; faint number is on-hand</span>
            </div>
            {sizes.length === 0 ? (
              <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>
                This style has no sized SKUs or size scale yet — nothing to adjust in matrix mode.
              </div>
            ) : (
              <EditableSizeMatrix
                rows={rows}
                sizes={sizes}
                showRise={hasMultiInseam}
                riseLabel="Inseam"
                qty={deltas}
                onQtyChange={setDelta}
                onHand={onHand}
                allowNegative
                unit={{
                  label: "Unit cost (¢)",
                  placeholder: "e.g. 1250",
                  values: unitCostMap,
                  onChange: (rowKey, v) => setUnitCostMap((p) => ({ ...p, [rowKey]: v })),
                  onSetAll: (v) => setUnitCostMap(() => Object.fromEntries(rows.map((r) => [r.key, v]))),
                }}
              />
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", position: "sticky", bottom: 0, background: C.card, paddingTop: 12, marginTop: 8, borderTop: `1px solid ${C.cardBdr}` }}>
          {progress && <span style={{ color: C.textMuted, fontSize: 12, marginRight: "auto" }}>{progress}</span>}
          <button type="button" style={btnSecondary} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" style={btnPrimary} onClick={() => void createAll()} disabled={saving || enteredCount === 0}>
            {saving ? "Creating…" : `Create ${enteredCount} adjustment(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
