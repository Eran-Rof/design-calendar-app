// src/tanda/InternalCycleCounts.tsx
//
// Tangerine P3 Chunk 6 - M37 Inventory Cycle Counts.
//
// List + detail-modal panel for inventory_cycle_counts.
//   • List with status filter + date range.
//   • "Start new count" button opens a small modal collecting
//     (count_date, location, optional scope_filter.item_ids).
//   • Click a row → detail modal: header + editable lines table
//     (counted_qty inline, variance auto-computed from server stored
//     GENERATED column on save).
//   • Finalize button → calls /finalize, surfaces summary in an alert.
//   • Cancel button (in_progress only) → PATCH status='cancelled'.
//
// Dark theme matching other Internal*.tsx panels.

import { useEffect, useState, useMemo } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import SearchableSelect from "./components/SearchableSelect";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { fmtDateDisplay } from "../utils/tandaTypes";

// Universal column-visibility registry for this panel (operator ask #1).
const CYCLE_COUNTS_TABLE_KEY = "tangerine:cyclecounts:columns";
const CYCLE_COUNT_COLUMNS: ColumnDef[] = [
  { key: "count_date", label: "Count date" },
  { key: "location",   label: "Location" },
  { key: "status",     label: "Status" },
  { key: "created",    label: "Created" },
  { key: "id",         label: "ID" },
];

type Status = "in_progress" | "completed" | "cancelled";

type CycleCount = {
  id: string;
  entity_id: string;
  count_date: string;
  location: string;
  status: Status;
  counted_by_user_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type CycleCountLine = {
  id: string;
  cycle_count_id: string;
  item_id: string;
  system_qty: number;
  counted_qty: number | null;
  variance_qty: number | null;
  adjustment_id: string | null;
  notes: string | null;
};

type CycleCountWithLines = CycleCount & { lines: CycleCountLine[] };

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", primaryDim: "#1d4ed8",
  success: "#10B981", warn: "#f59e0b", danger: "#EF4444",
  positive: "#34d399", negative: "#fb7185",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnDanger: React.CSSProperties = {
  background: C.danger, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSuccess: React.CSSProperties = {
  background: C.success, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
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

function statusBadge(s: Status): React.CSSProperties {
  const map: Record<Status, string> = {
    in_progress: C.warn,
    completed: C.success,
    cancelled: C.textMuted,
  };
  return {
    display: "inline-block", padding: "2px 8px", borderRadius: 4,
    background: map[s], color: "white", fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.3,
  };
}

const fmtDate = fmtDateDisplay;

function fmtVariance(v: number | null): { text: string; color: string } {
  if (v == null) return { text: "—", color: C.textMuted };
  if (v === 0) return { text: "0", color: C.textMuted };
  if (v > 0) return { text: `+${v}`, color: C.positive };
  return { text: `${v}`, color: C.negative };
}

export default function InternalCycleCounts() {
  const [rows, setRows] = useState<CycleCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<"" | Status>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [showStartModal, setShowStartModal] = useState(false);
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    CYCLE_COUNTS_TABLE_KEY,
    CYCLE_COUNT_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:cyclecounts:sort",
    accessors: { created: (cc) => cc.created_at },
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      const r = await fetch(`/api/internal/inventory-cycle-counts?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [statusFilter, fromDate, toDate]);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Cycle Counts</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Physical inventory counts → variance adjustments (drafts).
        </span>
        <button
          type="button"
          style={{ ...btnPrimary, marginLeft: "auto" }}
          onClick={() => setShowStartModal(true)}
        >
          + Start new count
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <SearchableSelect
          inputStyle={{ ...inputStyle, width: 180 }}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as "" | Status)}
          options={[
            { value: "", label: "All statuses" },
            { value: "in_progress", label: "In progress" },
            { value: "completed", label: "Completed" },
            { value: "cancelled", label: "Cancelled" },
          ]}
        />
        <input
          style={{ ...inputStyle, width: 160 }}
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          placeholder="From date"
        />
        <input
          style={{ ...inputStyle, width: 160 }}
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          placeholder="To date"
        />
        <DateRangePresets variant="dropdown"
          from={fromDate}
          to={toDate}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />
        <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          <TablePrefsButton
            tableKey={CYCLE_COUNTS_TABLE_KEY}
            columns={CYCLE_COUNT_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
          />
          <ExportButton
            rows={rows as unknown as Array<Record<string, unknown>>}
            filename="cycle-counts"
            sheetName="Cycle Counts"
            columns={[
              { key: "count_date",  header: "Count Date", format: "date" },
              { key: "location",    header: "Location" },
              { key: "status",      header: "Status" },
              { key: "created_at",  header: "Created",    format: "datetime" },
              { key: "updated_at",  header: "Updated",    format: "datetime" },
              { key: "id",          header: "ID" },
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
              <SortableTh label="Count date" sortKey="count_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("count_date")} />
              <SortableTh label="Location" sortKey="location" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("location")} />
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("status")} />
              <SortableTh label="Created" sortKey="created" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("created")} />
              <SortableTh label="ID" sortKey="id" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("id")} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={5}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={5}>
                <span style={{ color: C.textMuted }}>No cycle counts yet. Start one above.</span>
              </td></tr>
            )}
            {sorted.map((cc) => (
              <tr
                key={cc.id}
                style={{ cursor: "pointer" }}
                onClick={() => setOpenDetailId(cc.id)}
              >
                <td style={td} hidden={!isVisible("count_date")}>{fmtDate(cc.count_date)}</td>
                <td style={td} hidden={!isVisible("location")}>{cc.location}</td>
                <td style={td} hidden={!isVisible("status")}><span style={statusBadge(cc.status)}>{cc.status}</span></td>
                <td style={td} hidden={!isVisible("created")}>{fmtDate(cc.created_at)}</td>
                <td style={{ ...td, color: C.textSub }} hidden={!isVisible("id")}>{"—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showStartModal && (
        <StartCountModal
          onClose={() => setShowStartModal(false)}
          onCreated={(cc) => {
            setShowStartModal(false);
            void load();
            setOpenDetailId(cc.id);
          }}
        />
      )}

      {openDetailId && (
        <DetailModal
          cycleCountId={openDetailId}
          onClose={() => { setOpenDetailId(null); void load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StartCountModal
// ─────────────────────────────────────────────────────────────────────────────
function StartCountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (cc: CycleCount) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [countDate, setCountDate] = useState(today);
  const [location, setLocation] = useState("main");
  const [notes, setNotes] = useState("");
  const [scopeText, setScopeText] = useState(""); // newline-separated item uuids
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        count_date: countDate,
        location: location.trim() || "main",
      };
      if (notes.trim()) body.notes = notes.trim();
      const ids = scopeText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) body.scope_filter = { item_ids: ids };

      const r = await fetch("/api/internal/inventory-cycle-counts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const json = await r.json();
      onCreated(json.cycle_count);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell onClose={onClose} title="Start new cycle count" width={520}>
      {err && (
        <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {err}
        </div>
      )}
      <Field label="Count date">
        <input style={inputStyle} type="date" value={countDate} onChange={(e) => setCountDate(e.target.value)} />
      </Field>
      <Field label="Location">
        <input style={inputStyle} value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <Field label="Notes (optional)">
        <textarea
          style={{ ...inputStyle, minHeight: 60 }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <Field label="Scope filter — item UUIDs (one per line, optional)">
        <textarea
          style={{ ...inputStyle, minHeight: 80, fontFamily: "monospace", fontSize: 11 }}
          placeholder={"(blank = snapshot all items with open layers)\nUUIDs newline or comma-separated"}
          value={scopeText}
          onChange={(e) => setScopeText(e.target.value)}
        />
      </Field>
      <div style={{ position: "sticky", bottom: -24, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "16px -24px -24px", padding: "14px 24px", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
        <button type="button" style={btnSecondary} onClick={onClose} disabled={submitting}>Cancel</button>
        <button type="button" style={btnPrimary} onClick={submit} disabled={submitting}>
          {submitting ? "Starting…" : "Start count"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DetailModal — view + edit lines + finalize / cancel
// ─────────────────────────────────────────────────────────────────────────────
function DetailModal({
  cycleCountId,
  onClose,
}: {
  cycleCountId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<CycleCountWithLines | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editingDrafts, setEditingDrafts] = useState<Record<string, string>>({});
  // Resolve line item_id → human sku_code (no raw UUIDs in the lines table).
  const [skuById, setSkuById] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/inventory-cycle-counts/${cycleCountId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [cycleCountId]);

  // Resolve the line item ids to sku_code labels via the shared items endpoint.
  useEffect(() => {
    const ids = Array.from(new Set((data?.lines || []).map((ln) => ln.item_id).filter(Boolean)))
      .filter((id) => !(id in skuById));
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/internal/items?ids=${encodeURIComponent(ids.join(","))}`);
        if (!r.ok) return;
        const rows = (await r.json()) as Array<{ id: string; sku_code: string | null }>;
        if (cancelled) return;
        setSkuById((prev) => {
          const next = { ...prev };
          for (const it of rows) next[it.id] = it.sku_code || "—";
          return next;
        });
      } catch { /* leave as "—" */ }
    })();
    return () => { cancelled = true; };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveLine(lineId: string) {
    const raw = editingDrafts[lineId];
    if (raw == null || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      setErr("counted_qty must be a non-negative number");
      return;
    }
    try {
      const r = await fetch(
        `/api/internal/inventory-cycle-counts/${cycleCountId}/lines/${lineId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ counted_qty: n }),
        }
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setEditingDrafts((d) => {
        const out = { ...d }; delete out[lineId]; return out;
      });
      void load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function cancelCount() {
    if (!(await confirmDialog("Cancel this cycle count? Counted lines will be discarded."))) return;
    try {
      const r = await fetch(`/api/internal/inventory-cycle-counts/${cycleCountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function finalize() {
    if (!(await confirmDialog("Finalize? This generates variance adjustment drafts and marks the count completed."))) return;
    try {
      const r = await fetch(`/api/internal/inventory-cycle-counts/${cycleCountId}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const j = await r.json();
      notify(
        `Finalized.\n\n` +
        `Adjustments created: ${j.adjustments_created}\n` +
        `Lines with variance: ${j.lines_with_variance}\n` +
        `Skipped (zero variance): ${j.lines_skipped_zero}\n` +
        `Skipped (not counted): ${j.lines_skipped_not_counted}\n` +
        `Threshold breaches: ${j.threshold_breaches?.length ?? 0}\n\n` +
        `Adjustments are DRAFTS — review and post via the Adjustments panel.`,
        "success"
      );
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const counts = useMemo(() => {
    if (!data) return { entered: 0, total: 0, varianceLines: 0 };
    let entered = 0; let varianceLines = 0;
    for (const ln of data.lines) {
      if (ln.counted_qty != null) entered++;
      if (ln.variance_qty != null && Number(ln.variance_qty) !== 0) varianceLines++;
    }
    return { entered, total: data.lines.length, varianceLines };
  }, [data]);

  return (
    <ModalShell onClose={onClose} title={data ? `Cycle count · ${fmtDate(data.count_date)} · ${data.location}` : "Cycle count"} width={900}>
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}
      {err && (
        <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {err}
        </div>
      )}
      {data && (
        <>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12,
            marginBottom: 16, padding: 12, background: "#0b1220",
            border: `1px solid ${C.cardBdr}`, borderRadius: 6,
          }}>
            <Stat label="Date" value={fmtDate(data.count_date)} />
            <Stat label="Location" value={data.location} />
            <Stat label="Status" value={<span style={statusBadge(data.status)}>{data.status}</span>} />
            <Stat label="Lines" value={`${counts.entered} / ${counts.total} counted (${counts.varianceLines} variance)`} />
          </div>

          <div style={{ maxHeight: "50vh", overflow: "auto", border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Item</th>
                  <th style={th}>System</th>
                  <th style={th}>Counted</th>
                  <th style={th}>Variance</th>
                  <th style={th}>Adj</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((ln) => {
                  const draft = editingDrafts[ln.id];
                  const isDirty = draft != null && draft !== "" && Number(draft) !== ln.counted_qty;
                  const v = fmtVariance(ln.variance_qty);
                  const canEdit = data.status === "in_progress";
                  return (
                    <tr key={ln.id}>
                      <td style={{ ...td, color: C.textSub, fontSize: 11 }}>{skuById[ln.item_id] || "—"}</td>
                      <td style={td}>{ln.system_qty}</td>
                      <td style={td}>
                        {canEdit ? (
                          <input
                            type="number"
                            min="0"
                            step="any"
                            style={{ ...inputStyle, width: 100 }}
                            value={draft != null ? draft : (ln.counted_qty != null ? String(ln.counted_qty) : "")}
                            onChange={(e) => setEditingDrafts((d) => ({ ...d, [ln.id]: e.target.value }))}
                            onBlur={() => isDirty && void saveLine(ln.id)}
                            placeholder="—"
                          />
                        ) : (
                          ln.counted_qty ?? "—"
                        )}
                      </td>
                      <td style={{ ...td, color: v.color, fontWeight: 600 }}>{v.text}</td>
                      <td style={{ ...td, color: C.textSub, fontSize: 11 }}>
                        {ln.adjustment_id ? "Posted" : "—"}
                      </td>
                      <td style={td}>
                        {canEdit && isDirty && (
                          <button type="button" style={btnPrimary} onClick={() => void saveLine(ln.id)}>Save</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ position: "sticky", bottom: -24, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "16px -24px -24px", padding: "14px 24px", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
            <button type="button" style={btnSecondary} onClick={onClose}>Close</button>
            {data.status === "in_progress" && (
              <>
                <button type="button" style={btnDanger} onClick={() => void cancelCount()}>Cancel count</button>
                <button type="button" style={btnSuccess} onClick={() => void finalize()}>Finalize</button>
              </>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared modal shell + field + stat helpers
// ─────────────────────────────────────────────────────────────────────────────
function ModalShell({
  onClose, title, width, children,
}: {
  onClose: () => void;
  title: string;
  width: number;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
          padding: 24, width: `min(${width}px, 95vw)`, maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
        }}
      >
        <h2 style={{ margin: "0 0 16px 0", fontSize: 18 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", color: C.textMuted, fontSize: 11, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color: C.text, fontSize: 13, marginTop: 2 }}>{value}</div>
    </div>
  );
}
