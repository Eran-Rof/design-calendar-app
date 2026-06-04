// ScalePickerCell — type-to-search dropdown backed by the Tangerine
// size-scale master (size_scales table, via /api/internal/size-scales).
//
// Task 4 — moved off the legacy scale_master to the Tangerine size_scales
// master. The full list is small (entity-scoped, typically <100 rows), so we
// load it once (module-cached) and filter in-memory as the operator types.
// Mirrors the FabricPickerCell autocomplete UX. The stored value is the
// scale CODE (size_scales.code).

import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { searchSizeScales, type SizeScaleHit } from "../services/costingApi";
import { usePopoverAnchor } from "../hooks/usePopoverAnchor";

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
}

// Module-scoped cache — shared across every grid cell so we hit the
// endpoint once per page load, not once per row.
let scaleCache: SizeScaleHit[] | null = null;
let scalePromise: Promise<SizeScaleHit[]> | null = null;

async function loadScales(): Promise<SizeScaleHit[]> {
  if (scaleCache) return scaleCache;
  if (!scalePromise) {
    scalePromise = searchSizeScales().then((rows) => { scaleCache = rows; return rows; }).catch(() => []);
  }
  return scalePromise;
}

export default function ScalePickerCell({ value, onChange }: Props) {
  const [scales, setScales] = useState<SizeScaleHit[]>(scaleCache || []);
  const [text, setText] = useState(value || "");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Portal the dropdown out of the grid's overflow:hidden cell. Anchor to the
  // cell wrapper; matches ColorPickerCell.
  const { anchorRef, pos } = usePopoverAnchor<HTMLDivElement>({ open, minWidth: 240 });

  useEffect(() => { setText(value || ""); }, [value]);

  useEffect(() => {
    if (scaleCache) { setScales(scaleCache); return; }
    let cancelled = false;
    loadScales().then((rows) => { if (!cancelled) setScales(rows); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const lowerText = text.trim().toLowerCase();
  const matches = scales.filter((s) =>
    !lowerText
    || (s.code || "").toLowerCase().includes(lowerText)
    || (s.name || "").toLowerCase().includes(lowerText),
  );

  const onCommit = (next: string | null) => {
    setText(next || "");
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <div
        ref={anchorRef}
        title={value ? `Scale: ${value}` : "Click to pick a size scale"}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          border: `1px ${value ? "solid" : "dashed"} #475569`,
          borderRadius: 3, cursor: "pointer",
        }}
      >
        <input
          ref={inputRef}
          value={text}
          placeholder="— pick scale —"
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            // Defer so a click on a dropdown row registers first; preserve free
            // text so a legacy/non-master scale still commits.
            window.setTimeout(() => { if (!open) onChange(e.target.value || null); }, 100);
          }}
          style={{
            flex: 1, minWidth: 0, padding: "4px 6px", fontSize: 12,
            background: "transparent", border: "none",
            color: value ? "#E2E8F0" : "#94A3B8", outline: "none",
          }}
        />
        <span
          onMouseDown={(e) => { e.preventDefault(); if (open) { setOpen(false); } else { inputRef.current?.focus(); setOpen(true); } }}
          style={{ color: "#64748B", fontSize: 9, paddingRight: 6, paddingLeft: 4, cursor: "pointer", alignSelf: "stretch", display: "flex", alignItems: "center" }}
        >▾</span>
      </div>
      {open && pos && ReactDOM.createPortal(
        <div ref={popRef} style={{
          position: "fixed", left: pos.left, top: pos.top, width: pos.width,
          zIndex: 9999, maxHeight: 280, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 8, boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
        }}>
          {value && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onCommit(null); }}
              style={{ ...DROPDOWN_BTN_STYLE, color: "#94A3B8", fontStyle: "italic" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >— clear —</button>
          )}
          {matches.map((s) => (
            <button
              key={s.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onCommit(s.code); }}
              style={{ ...DROPDOWN_BTN_STYLE, fontWeight: s.code === value ? 700 : 400 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 600 }}>{s.code}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>
                {s.name || ""}
                {Array.isArray(s.sizes) && s.sizes.length > 0 ? ` · ${s.sizes.join("/")}` : ""}
              </div>
            </button>
          ))}
          {matches.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>
              {scales.length === 0 ? "Loading scales…" : `No scale matches "${text}".`}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

const DROPDOWN_BTN_STYLE: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left",
  padding: "5px 10px", background: "transparent",
  border: "none", borderBottom: "1px solid #334155",
  color: "#E2E8F0", cursor: "pointer", fontSize: 12,
};
