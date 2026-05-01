// Searchable single-select dropdown. Used wherever a native <select> has
// enough options that scanning by eye is painful (customers, categories,
// sub-cats). Same value/onChange contract as a native select with an "all"
// sentinel for the "no filter" option.

import { useEffect, useMemo, useRef, useState } from "react";
import { S, PAL } from "./styles";

export interface SearchableSelectProps {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  // Label shown when value === "all". Also acts as the reset row at the
  // top of the option list.
  allLabel?: string;
  placeholder?: string;
  title?: string;
  minWidth?: number;
}

export function SearchableSelect({
  value, onChange, options, allLabel = "All", placeholder = "Search…", title, minWidth = 180,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const currentLabel = value === "all"
    ? allLabel
    : options.find((o) => o.value === value)?.label ?? allLabel;

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

  function commit(v: string) {
    onChange(v);
    setOpen(false);
    setQuery("");
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
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentLabel}</span>
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
            minWidth: Math.max(minWidth, 240),
            maxHeight: 340,
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
          }}>
            <input
              autoFocus
              style={{ ...S.input, width: "100%" }}
              placeholder={placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered.length === 1) {
                  commit(filtered[0].value);
                }
              }}
            />
          </div>
          <div
            role="option"
            aria-selected={value === "all"}
            style={{
              padding: "8px 12px",
              cursor: "pointer",
              fontSize: 13,
              color: PAL.textDim,
              borderBottom: `1px solid ${PAL.borderFaint}`,
              background: value === "all" ? PAL.bg : undefined,
            }}
            onClick={() => commit("all")}
          >
            {allLabel}
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          ) : (
            filtered.map((o) => (
              <div
                key={o.value}
                role="option"
                aria-selected={value === o.value}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  color: PAL.text,
                  background: value === o.value ? PAL.bg : undefined,
                }}
                onClick={() => commit(o.value)}
              >
                {o.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
