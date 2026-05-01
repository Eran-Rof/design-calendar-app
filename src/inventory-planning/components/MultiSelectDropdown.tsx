// Multi-select dropdown with search + per-option checkboxes. Used by
// the wholesale grid filter strip so the planner can scope to several
// customers / categories / etc. at once instead of one at a time.
// Empty `selected` = no filter (everything passes).

import { useEffect, useMemo, useRef, useState } from "react";
import { S, PAL } from "./styles";

export interface MultiSelectDropdownProps {
  selected: string[];
  onChange: (next: string[]) => void;
  options: Array<{ value: string; label: string }>;
  // Label shown on the trigger button when `selected` is empty.
  allLabel?: string;
  placeholder?: string;
  title?: string;
  minWidth?: number;
}

export function MultiSelectDropdown({
  selected, onChange, options, allLabel = "All", placeholder = "Search…", title, minWidth = 180,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const buttonLabel = (() => {
    if (selected.length === 0) return allLabel;
    if (selected.length === 1) {
      return options.find((o) => o.value === selected[0])?.label ?? selected[0];
    }
    return `${allLabel} · ${selected.length} selected`;
  })();

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  function toggle(value: string) {
    if (selectedSet.has(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        style={{
          ...S.select,
          cursor: "pointer",
          textAlign: "left" as const,
          minWidth,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{buttonLabel}</span>
        <span style={{ color: PAL.textMuted, fontSize: 10 }}>▾</span>
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
            minWidth: Math.max(minWidth, 260),
            maxHeight: 380,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{
            padding: 8,
            borderBottom: `1px solid ${PAL.borderFaint}`,
            position: "sticky" as const,
            top: 0,
            background: PAL.panel,
            zIndex: 1,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}>
            <input
              autoFocus
              type="text"
              placeholder={placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ ...S.input, flex: 1, minWidth: 0 }}
            />
            {selected.length > 0 && (
              <button
                type="button"
                style={{ ...S.btnGhost, fontSize: 11, whiteSpace: "nowrap" }}
                onClick={() => onChange([])}
                title="Clear all selections"
              >
                Clear
              </button>
            )}
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          ) : (
            filtered.map((o) => {
              const isSelected = selectedSet.has(o.value);
              return (
                <label
                  key={o.value}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                    color: isSelected ? PAL.text : PAL.textDim,
                    background: isSelected ? PAL.bg : undefined,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(o.value)}
                  />
                  {o.label}
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
