// src/tanda/InternalUpcReport.tsx
//
// Tangerine — UPC Report (Reports menu group). Lists upc_item_master joined to
// style_master, grain (style, color, size). Read-only; reuses the existing
// upc_item_master table via /api/internal/upc-items. Search + xlsx export.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

const TABLE_KEY = "tanda.upc_report";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "style_code", label: "Style" },
  { key: "style_name", label: "Style Name" },
  { key: "color",      label: "Color" },
  { key: "size",       label: "Size" },
  { key: "upc",        label: "UPC" },
  { key: "source",     label: "Source" },
];

type Row = {
  upc: string;
  style_code: string;
  style_name: string | null;
  color: string;
  size: string;
  description: string | null;
  source: string | null;
};

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6",
};
const th: React.CSSProperties = {
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap",
  background: "#0b1220", position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, color: C.text,
};

// Source labels: gs1 (minted) vs excel/xoro (imported). Kept generic so future
// source_method values still render.
function sourceLabel(s: string | null): string {
  if (!s) return "—";
  if (s === "gs1") return "GS1 (minted)";
  if (s === "excel") return "Excel";
  if (s === "xoro") return "Xoro";
  return s;
}

export default function InternalUpcReport() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { value: input, setValue: setInput, debouncedValue: debounced } = useDebouncedSearch("", 200);
  const { isVisible } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const params = new URLSearchParams();
        if (debounced.trim()) params.set("q", debounced.trim());
        const r = await fetch(`/api/internal/upc-items?${params.toString()}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debounced]);

  const exportRows = useMemo(
    () => rows.map((r) => ({ ...r, source_label: sourceLabel(r.source) })),
    [rows],
  );

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>UPC Report</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>{rows.length} UPC{rows.length === 1 ? "" : "s"}</span>
        <div style={{ flex: 1 }} />
        <DynamicSearchInput
          value={input}
          onChange={setInput}
          placeholder="Search style / color / size / UPC…"
        />
        <ExportButton
          rows={exportRows as unknown as Array<Record<string, unknown>>}
          filename="upc-report"
          sheetName="UPC Report"
          columns={[
            { key: "style_code",   header: "Style" },
            { key: "style_name",   header: "Style Name" },
            { key: "color",        header: "Color" },
            { key: "size",         header: "Size" },
            { key: "upc",          header: "UPC" },
            { key: "source_label", header: "Source" },
          ]}
        />
        <TablePrefsButton tableKey={TABLE_KEY} columns={ALL_COLUMNS} />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
          {err}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No UPCs found.</div>
      ) : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("style_code")}>Style</th>
                <th style={th} hidden={!isVisible("style_name")}>Style Name</th>
                <th style={th} hidden={!isVisible("color")}>Color</th>
                <th style={th} hidden={!isVisible("size")}>Size</th>
                <th style={th} hidden={!isVisible("upc")}>UPC</th>
                <th style={th} hidden={!isVisible("source")}>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.upc}>
                  <td style={td} hidden={!isVisible("style_code")}>{r.style_code}</td>
                  <td style={td} hidden={!isVisible("style_name")}>{r.style_name || "—"}</td>
                  <td style={td} hidden={!isVisible("color")}>{r.color}</td>
                  <td style={td} hidden={!isVisible("size")}>{r.size}</td>
                  <td style={{ ...td, fontFamily: "monospace" }} hidden={!isVisible("upc")}>{r.upc}</td>
                  <td style={td} hidden={!isVisible("source")}>{sourceLabel(r.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
