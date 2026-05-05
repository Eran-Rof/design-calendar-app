// Column visibility picker. Opens a checklist popover the planner
// uses to hide/show grid columns. The list mirrors the grid header
// declaration order so toggling matches what the planner sees on
// screen.

import { useEffect, useRef, useState } from "react";
import { S, PAL } from "../styles";

export function ColumnsButton({
  columns,
  hidden,
  onToggle,
  onReset,
}: {
  columns: Array<{ key: string; label: string }>;
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reset the search input each time the popover closes so reopening
  // starts fresh.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const hiddenCount = hidden.size;
  const q = query.trim().toLowerCase();
  const filteredColumns = q
    ? columns.filter((c) => c.label.toLowerCase().includes(q))
    : columns;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        style={S.btnSecondary}
        onClick={() => setOpen((v) => !v)}
        title="Show or hide grid columns"
      >
        Columns{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            background: PAL.panel,
            border: `1px solid ${PAL.border}`,
            borderRadius: 8,
            minWidth: 240,
            maxHeight: 420,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{
            padding: "8px 12px",
            borderBottom: `1px solid ${PAL.borderFaint}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 12,
            color: PAL.textMuted,
            textTransform: "uppercase",
            letterSpacing: 1,
            position: "sticky" as const,
            top: 0,
            background: PAL.panel,
            zIndex: 1,
          }}>
            <span>Visible columns</span>
            <button type="button" style={{ ...S.btnGhost, fontSize: 11 }} onClick={onReset}>Show all</button>
          </div>
          <div style={{
            padding: 8,
            borderBottom: `1px solid ${PAL.borderFaint}`,
            position: "sticky" as const,
            top: 33,
            background: PAL.panel,
            zIndex: 1,
          }}>
            <input
              autoFocus
              type="text"
              placeholder="Search columns…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ ...S.input, width: "100%" }}
            />
          </div>
          {filteredColumns.length === 0 ? (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          ) : (
            filteredColumns.map((c) => {
              const visible = !hidden.has(c.key);
              return (
                <label
                  key={c.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                    color: visible ? PAL.text : PAL.textMuted,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => onToggle(c.key)}
                  />
                  {c.label}
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
