// ScalePickerCell — type-to-search dropdown backed by the Tangerine
// size-scale master (size_scales table, via /api/internal/size-scales).
//
// Task 4 — moved off the legacy scale_master to the Tangerine size_scales
// master. The full list is small (entity-scoped, typically <100 rows), so we
// load it once (module-cached) and filter in-memory as the operator types.
// Mirrors the FabricPickerCell autocomplete UX. The stored value is the
// scale CODE (size_scales.code).

import React, { useEffect, useRef, useState } from "react";
import { searchSizeScales, type SizeScaleHit } from "../services/costingApi";

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
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
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
      <input
        value={text}
        placeholder="Scale"
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // Defer so a click on a dropdown row registers first; preserve free
          // text so a legacy/non-master scale still commits.
          window.setTimeout(() => { if (!open) onChange(e.target.value || null); }, 100);
        }}
        style={{
          width: "100%", padding: "4px 6px", fontSize: 12,
          background: "transparent", border: "1px solid transparent",
          color: "#E2E8F0", outline: "none",
        }}
      />
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 50,
          minWidth: 240, maxHeight: 280, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
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
        </div>
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
