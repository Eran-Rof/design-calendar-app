// StylePickerCell — autocomplete cell for picking a style_master row.
//
// Renders as a free-text input. Each keystroke fires a debounced search
// against /api/internal/costing/search/styles. The dropdown lists up to 25
// hits; clicking one calls onPick(style) so the parent (CostingGrid row)
// can apply the prefill + seed target_cost via resolveCost().

import React, { useEffect, useRef, useState } from "react";
import { useStyleSearch } from "../hooks/useStyleSearch";
import type { StyleHit } from "../services/costingApi";

interface Props {
  value: string | null;
  onPick: (style: StyleHit) => void;
  onChange?: (next: string) => void;
  placeholder?: string;
  cellStyle?: React.CSSProperties;
}

export default function StylePickerCell({ value, onPick, onChange, placeholder, cellStyle }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value || "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const { rows, loading, search } = useStyleSearch();

  // Sync external value changes.
  useEffect(() => { setText(value || ""); }, [value]);

  // Outside-click closer.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={text}
        placeholder={placeholder || "Type style code…"}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          onChange?.(v);
          search(v);
          setOpen(true);
        }}
        onFocus={() => { if (text) { search(text); setOpen(true); } }}
        style={{
          width: "100%", padding: "4px 6px", fontSize: 12,
          border: "1px solid transparent", background: "transparent",
          color: "#E2E8F0", outline: "none",
          ...cellStyle,
        }}
      />
      {open && (rows.length > 0 || loading) && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 50,
          minWidth: 320, maxHeight: 280, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
        }}>
          {loading && <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>Searching…</div>}
          {rows.map((s) => (
            <button
              key={s.id}
              type="button"
              onMouseDown={(e) => {
                // Use mousedown so the input doesn't blur first.
                e.preventDefault();
                setText(s.style_code || "");
                setOpen(false);
                onPick(s);
              }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 10px", background: "transparent",
                border: "none", borderBottom: "1px solid #334155",
                color: "#E2E8F0", cursor: "pointer", fontSize: 12,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 600 }}>{s.style_code}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>
                {s.style_name || s.description || ""}
                {s.gender_code ? ` · ${s.gender_code}` : ""}
                {s.base_fabric ? ` · ${s.base_fabric}` : ""}
              </div>
            </button>
          ))}
          {!loading && rows.length === 0 && text && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>No matches.</div>
          )}
        </div>
      )}
    </div>
  );
}
