// ColorPickerCell — autocomplete cell for the color column.
//
// Suggestions come from /api/internal/costing/search/colors, which returns
// distinct ip_item_master.color values + any operator-added extras stored
// under app_data.costing_extra_colors. Typing a new value and blurring
// keeps it on the line; the operator can click "+ Add" to remember it for
// future autocomplete.

import React, { useEffect, useRef, useState } from "react";
import { searchColors } from "../services/costingApi";
import { useCostingStore } from "../store/costingStore";

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
  /**
   * When provided, the dropdown only shows colors that exist on SKUs under
   * this style code in ip_item_master. Falls back to all colors when null.
   * Operator-added extras (costing_extra_colors) are always included
   * regardless — those are global suggestions, not style-scoped.
   */
  styleCode?: string | null;
  cellStyle?: React.CSSProperties;
}

export default function ColorPickerCell({ value, onChange, styleCode, cellStyle }: Props) {
  const [text, setText] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const addExtraColor = useCostingStore((s) => s.addExtraColor);
  const setNotice     = useCostingStore((s) => s.setNotice);

  useEffect(() => { setText(value || ""); }, [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // Debounced search. Re-fires when styleCode changes so picking a new style
  // re-scopes the color list to that style's available colors.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const out = await searchColors(text, { styleCode, signal: controller.signal });
        setRows(out);
      } catch { /* silent */ }
    }, 200);
    return () => { window.clearTimeout(t); controller.abort(); };
  }, [text, open, styleCode]);

  const onCommit = (next: string | null) => {
    setText(next || "");
    onChange(next);
    setOpen(false);
  };

  const canAdd = text.trim().length > 0 && !rows.some((r) => r.toLowerCase() === text.trim().toLowerCase());

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={text}
        placeholder="Color"
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // Defer so click on dropdown row registers first.
          window.setTimeout(() => { if (!open) onChange(e.target.value || null); }, 100);
        }}
        style={{
          width: "100%", padding: "4px 6px", fontSize: 12,
          background: "transparent", border: "1px solid transparent",
          color: "#E2E8F0", outline: "none",
          ...cellStyle,
        }}
      />
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 50,
          minWidth: 180, maxHeight: 220, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
        }}>
          {rows.slice(0, 30).map((c) => (
            <button
              key={c}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onCommit(c); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "5px 10px", background: "transparent",
                border: "none", borderBottom: "1px solid #334155",
                color: "#E2E8F0", cursor: "pointer", fontSize: 12,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >{c}</button>
          ))}
          {rows.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>No suggestions.</div>
          )}
          {canAdd && (
            <button
              type="button"
              onMouseDown={async (e) => {
                e.preventDefault();
                const v = text.trim();
                await addExtraColor(v);
                onCommit(v);
                setNotice(`Saved "${v}" for future autocomplete`, "info");
              }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 10px", background: "#0F172A",
                border: "none", color: "#10B981", cursor: "pointer", fontSize: 12, fontWeight: 600,
              }}
            >+ Add "{text.trim()}"</button>
          )}
        </div>
      )}
    </div>
  );
}
