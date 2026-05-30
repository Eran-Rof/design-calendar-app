// StylePickerCell — autocomplete cell for picking a style_master row.
//
// The dropdown is rendered into document.body via a portal with
// position:fixed so it isn't clipped by the grid's overflow:auto wrapper.
// Width is computed from the input's getBoundingClientRect so the popup
// hugs the cell on the left but extends to ~280px wide for readability.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useStyleSearch } from "../hooks/useStyleSearch";
import type { StyleHit } from "../services/costingApi";

interface Props {
  value: string | null;
  onPick: (style: StyleHit) => void;
  onChange?: (next: string) => void;
  placeholder?: string;
  cellStyle?: React.CSSProperties;
}

interface Position { left: number; top: number; width: number }

export default function StylePickerCell({ value, onPick, onChange, placeholder, cellStyle }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value || "");
  const [pos, setPos] = useState<Position | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { rows, loading, search } = useStyleSearch();

  useEffect(() => { setText(value || ""); }, [value]);

  // Outside-click closer — must consider both the input and the portaled popup.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (inputRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // Recompute popup position when opening or when the input moves (scroll).
  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    const compute = () => {
      const r = inputRef.current!.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 200) });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open]);

  const popup = open && pos && (rows.length > 0 || loading) ? ReactDOM.createPortal(
    <div
      ref={popRef}
      style={{
        position: "fixed", left: pos.left, top: pos.top, width: pos.width,
        maxHeight: 260, overflowY: "auto",
        background: "#1E293B", border: "1px solid #475569",
        borderRadius: 4, boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
        zIndex: 9999,
      }}
    >
      {loading && <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>Searching…</div>}
      {rows.map((s) => (
        <button
          key={s.id}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            setText(s.style_code || "");
            setOpen(false);
            onPick(s);
          }}
          style={{
            display: "block", width: "100%", textAlign: "left",
            padding: "5px 10px", background: "transparent",
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
    </div>,
    document.body,
  ) : null;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <input
        ref={inputRef}
        value={text}
        placeholder={placeholder || "Style…"}
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
      {popup}
    </div>
  );
}
