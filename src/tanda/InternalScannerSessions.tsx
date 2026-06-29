// src/tanda/InternalScannerSessions.tsx
//
// Tangerine P3 Chunk 8 — M39 Mobile Scanner read-only troubleshooting view.
// Per docs/tangerine/P3-acc-core-architecture.md §6.7.
//
// Lists scanner sessions with status filter. Clicking a row opens a modal
// showing the session header + scrollable event log (one row per
// scanner_events entry).
//
// NO edit / submit / cancel buttons — the mobile app owns those flows. This
// panel is for admin troubleshooting only.

import { useEffect, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useItemResolver } from "./hooks/useItemResolver";

// Universal column-visibility registry for this panel (operator ask #1).
const SCANNER_SESSIONS_TABLE_KEY = "tangerine:scannersessions:columns";
const SCANNER_SESSION_COLUMNS: ColumnDef[] = [
  { key: "created",   label: "Created" },
  { key: "mode",      label: "Mode" },
  { key: "target",    label: "Target" },
  { key: "status",    label: "Status" },
  { key: "device",    label: "Device" },
  { key: "last_scan", label: "Last Scan" },
  { key: "submitted", label: "Submitted" },
];

type ScannerSession = {
  id: string;
  entity_id: string;
  device_user_id: string;
  mode: "receive" | "pick" | "transfer" | "count";
  target_kind: "po" | "so" | "cycle_count" | "adhoc";
  target_id: string | null;
  status: "open" | "submitted" | "cancelled";
  scanned_at: string | null;
  submitted_at: string | null;
  client_meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type ScannerEvent = {
  id: string;
  session_id: string;
  client_event_id: string;
  scanned_barcode: string;
  resolved_item_id: string | null;
  qty: number | string;
  client_timestamp: string;
  server_received_at: string;
  notes: string | null;
};

type SessionWithEvents = ScannerSession & { events: ScannerEvent[] };

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", danger: "#EF4444",
  warn: "#f59e0b",
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
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
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};

function statusColor(status: string): string {
  if (status === "open") return C.warn;
  if (status === "submitted") return C.success;
  if (status === "cancelled") return C.textMuted;
  return C.text;
}

export default function InternalScannerSessions() {
  const [rows, setRows] = useState<ScannerSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [modeFilter, setModeFilter] = useState<string>("");
  const [active, setActive] = useState<SessionWithEvents | null>(null);
  const [loadingActive, setLoadingActive] = useState(false);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    SCANNER_SESSIONS_TABLE_KEY,
    SCANNER_SESSION_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  // target (composite) and device (truncated id) stay non-sortable.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:scannersessions:sort",
    accessors: {
      created: (s) => s.created_at,
      last_scan: (s) => s.scanned_at,
      submitted: (s) => s.submitted_at,
    },
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (modeFilter) params.set("mode", modeFilter);
      params.set("limit", "250");
      const r = await fetch(`/api/internal/scanner/sessions?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [statusFilter, modeFilter]);

  async function openSession(s: ScannerSession) {
    setLoadingActive(true);
    try {
      const r = await fetch(`/api/internal/scanner/sessions/${s.id}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setActive(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingActive(false);
    }
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Scanner Sessions</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          M39 mobile scanner — read-only troubleshooting view. Click a row to see the event log.
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        <label style={{ color: C.textSub, fontSize: 12 }}>Status</label>
        <SearchableSelect
          inputStyle={inputStyle}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v)}
          options={[
            { value: "", label: "(any)" },
            { value: "open", label: "open" },
            { value: "submitted", label: "submitted" },
            { value: "cancelled", label: "cancelled" },
          ]}
        />
        <label style={{ color: C.textSub, fontSize: 12 }}>Mode</label>
        <SearchableSelect
          inputStyle={inputStyle}
          value={modeFilter}
          onChange={(v) => setModeFilter(v)}
          options={[
            { value: "", label: "(any)" },
            { value: "receive", label: "receive" },
            { value: "pick", label: "pick" },
            { value: "transfer", label: "transfer" },
            { value: "count", label: "count" },
          ]}
        />
        <button style={{ ...btnSecondary, marginLeft: "auto" }} onClick={() => void load()}>Refresh</button>
        <TablePrefsButton
          tableKey={SCANNER_SESSIONS_TABLE_KEY}
          columns={SCANNER_SESSION_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="scanner-sessions"
          sheetName="Scanner Sessions"
          columns={[
            { key: "created_at",      header: "Created",      format: "datetime" },
            { key: "mode",            header: "Mode" },
            { key: "target_kind",     header: "Target Kind" },
            { key: "target_id",       header: "Target ID" },
            { key: "status",          header: "Status" },
            { key: "device_user_id",  header: "Device User" },
            { key: "scanned_at",      header: "Last Scan",    format: "datetime" },
            { key: "submitted_at",    header: "Submitted",    format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortableTh label="Created" sortKey="created" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("created")} />
              <SortableTh label="Mode" sortKey="mode" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("mode")} />
              <th style={th} hidden={!isVisible("target")}>Target</th>
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("status")} />
              <th style={th} hidden={!isVisible("device")}>Device</th>
              <SortableTh label="Last Scan" sortKey="last_scan" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("last_scan")} />
              <SortableTh label="Submitted" sortKey="submitted" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("submitted")} />
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={8}>Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={8}>
                <span style={{ color: C.textMuted }}>No sessions match the current filter.</span>
              </td></tr>
            )}
            {sorted.map((s) => (
              <tr key={s.id} style={s.status === "cancelled" ? { opacity: 0.6 } : {}}>
                <td style={{ ...td, color: C.textMuted, fontFamily: "monospace" }} hidden={!isVisible("created")}>
                  {new Date(s.created_at).toLocaleString()}
                </td>
                <td style={td} hidden={!isVisible("mode")}>{s.mode}</td>
                <td style={td} hidden={!isVisible("target")}>{s.target_kind}</td>
                <td style={{ ...td, color: statusColor(s.status), fontWeight: 600 }} hidden={!isVisible("status")}>{s.status}</td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!isVisible("device")}>
                  —
                </td>
                <td style={{ ...td, color: C.textSub }} hidden={!isVisible("last_scan")}>
                  {s.scanned_at ? new Date(s.scanned_at).toLocaleString() : "—"}
                </td>
                <td style={{ ...td, color: C.textSub }} hidden={!isVisible("submitted")}>
                  {s.submitted_at ? new Date(s.submitted_at).toLocaleString() : "—"}
                </td>
                <td style={td}>
                  <button style={btnSecondary} onClick={() => void openSession(s)} disabled={loadingActive}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {active && <SessionDetailModal session={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function SessionDetailModal({ session, onClose }: { session: SessionWithEvents; onClose: () => void }) {
  const itemIds = session.events.map((e) => e.resolved_item_id).filter(Boolean) as string[];
  const { itemMap } = useItemResolver(itemIds, itemIds.length > 0);
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
        padding: 24, width: "min(880px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", display: "flex", flexDirection: "column",
      }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            {session.mode} session · {new Date(session.created_at).toLocaleString()}
          </h2>
          <span style={{
            marginLeft: 12, padding: "2px 8px", borderRadius: 4,
            background: statusColor(session.status), color: "white", fontSize: 11, fontWeight: 600,
          }}>
            {session.status}
          </span>
          <button style={{ ...btnSecondary, marginLeft: "auto" }} onClick={onClose}>Close</button>
        </div>

        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12,
          padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`,
          borderRadius: 6, marginBottom: 16,
        }}>
          <Stat label="Mode" value={session.mode} />
          <Stat label="Target Kind" value={session.target_kind} />
          <Stat label="Target ID" value="—" />
          <Stat label="Device User" value="—" />
          <Stat label="Created" value={new Date(session.created_at).toLocaleString()} />
          <Stat label="Submitted" value={session.submitted_at ? new Date(session.submitted_at).toLocaleString() : "—"} />
          <Stat label="Last Scan" value={session.scanned_at ? new Date(session.scanned_at).toLocaleString() : "—"} />
          <Stat label="Event Count" value={String(session.events.length)} />
          <Stat label="Entity" value="—" />
        </div>

        {Object.keys(session.client_meta || {}).length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>
              Client Meta
            </div>
            <pre style={{
              background: "#0b1220", padding: 8, borderRadius: 4,
              color: C.textSub, fontSize: 11, overflow: "auto", margin: 0,
            }}>
              {JSON.stringify(session.client_meta, null, 2)}
            </pre>
          </div>
        )}

        <div style={{ flex: 1, overflow: "auto", border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ position: "sticky", top: 0 }}>
              <tr>
                <th style={th}>#</th>
                <th style={th}>Server Received</th>
                <th style={th}>Client TS</th>
                <th style={th}>Barcode</th>
                <th style={th}>Resolved Item</th>
                <th style={th}>Qty</th>
                <th style={th}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {session.events.length === 0 && (
                <tr><td style={td} colSpan={7}>
                  <span style={{ color: C.textMuted }}>No events recorded.</span>
                </td></tr>
              )}
              {session.events.map((ev, i) => (
                <tr key={ev.id}>
                  <td style={{ ...td, color: C.textMuted, fontSize: 11 }}>{i + 1}</td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>
                    {new Date(ev.server_received_at).toLocaleString()}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 11, color: C.textSub }}>
                    {new Date(ev.client_timestamp).toLocaleString()}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{ev.scanned_barcode}</td>
                  <td style={{ ...td, fontSize: 11, color: ev.resolved_item_id ? C.text : C.danger }}>
                    {ev.resolved_item_id ? (itemMap.get(ev.resolved_item_id)?.sku_code || "—") : "unresolved"}
                  </td>
                  <td style={td}>{ev.qty}</td>
                  <td style={{ ...td, color: C.textSub }}>{ev.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ color: C.textMuted, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ color: C.text, fontSize: 12, fontFamily: mono ? "monospace" : undefined, wordBreak: "break-all" }}>
        {value}
      </div>
    </div>
  );
}
