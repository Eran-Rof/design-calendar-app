// Column visibility picker for the costing grid. Mirrors the planning
// ColumnsButton pattern but dark-themed to match the costing grid.
// State is persisted via usePersistedHiddenColumns("costing_grid_hidden_columns").

import { useEffect, useRef, useState } from "react";

export interface ColumnDescriptor { key: string; label: string }

export default function ColumnsButton({
  columns, hidden, onToggle, onReset,
}: {
  columns: ColumnDescriptor[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const hiddenCount = hidden.size;
  const q = query.trim().toLowerCase();
  const filtered = q ? columns.filter((c) => c.label.toLowerCase().includes(q)) : columns;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Show or hide grid columns"
        style={{
          background: hiddenCount > 0 ? "#1E40AF" : "transparent",
          color: hiddenCount > 0 ? "#fff" : "#CBD5E1",
          border: "1px solid #334155", borderRadius: 4,
          padding: "5px 12px", fontSize: 12, fontWeight: 600,
          cursor: "pointer", whiteSpace: "nowrap",
        }}
      >Columns{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}</button>

      {open && (
        <div style={{
          position: "absolute", top: "100%", right: 0, zIndex: 100,
          marginTop: 4, width: 280, maxHeight: 440, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          padding: "10px 0",
        }}>
          <div style={{ padding: "0 10px 8px", borderBottom: "1px solid #334155" }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter columns…"
              style={{
                width: "100%", padding: "5px 8px", fontSize: 12,
                background: "#0F172A", color: "#E2E8F0",
                border: "1px solid #334155", borderRadius: 4, outline: "none",
              }}
            />
          </div>
          <div style={{ padding: "6px 0" }}>
            {filtered.length === 0 && (
              <div style={{ padding: 12, fontSize: 12, color: "#64748B", textAlign: "center" }}>No matches.</div>
            )}
            {filtered.map((c) => {
              const isHidden = hidden.has(c.key);
              return (
                <label
                  key={c.key}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "5px 12px", cursor: "pointer",
                    color: "#E2E8F0", fontSize: 12,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#334155"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => onToggle(c.key)}
                    style={{ accentColor: "#60A5FA" }}
                  />
                  <span style={{ flex: 1 }}>{c.label || c.key}</span>
                </label>
              );
            })}
          </div>
          {hiddenCount > 0 && (
            <div style={{ borderTop: "1px solid #334155", padding: "8px 10px 0" }}>
              <button
                type="button"
                onClick={onReset}
                style={{
                  background: "transparent", color: "#60A5FA",
                  border: "none", padding: "4px 0", cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                }}
              >Show all columns</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
