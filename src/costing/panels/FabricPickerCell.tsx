// FabricPickerCell — autocomplete cell for fabric_codes.
//
// Unlike scale_master, fabric_codes can grow into the hundreds, and styles
// reference fabrics by `code` (not by id) — same shape as the existing
// `style_master.base_fabric` column the grid auto-fills on style pick. So
// the cell stores the fabric CODE (string) and offers an autocomplete on
// code + name.
//
// No inline-add — fabric setup belongs in a dedicated Fabric Library admin
// UI (the existing fabric_codes table carries composition, weight, HTS
// code, etc. that don't fit in a grid prompt). Operators who need a new
// fabric should add it there.

import React, { useEffect, useRef, useState } from "react";
import { searchFabrics, type FabricHit } from "../services/costingApi";

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
}

export default function FabricPickerCell({ value, onChange }: Props) {
  const [text, setText] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FabricHit[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setText(value || ""); }, [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const out = await searchFabrics(text, controller.signal);
        setRows(out);
      } catch { /* silent */ }
      finally { setLoading(false); }
    }, 200);
    return () => { window.clearTimeout(t); controller.abort(); };
  }, [text, open]);

  const onCommit = (next: string | null) => {
    setText(next || "");
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={text}
        placeholder="Fabric"
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // Defer so click on dropdown row registers first; preserve free
          // text so style auto-fill (style.base_fabric) survives a blur.
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
          minWidth: 240, maxHeight: 260, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
        }}>
          {loading && <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>Searching…</div>}
          {!loading && rows.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>
              {text ? `No fabric matches "${text}". Type to keep as freeform.` : "Type to search fabrics…"}
            </div>
          )}
          {rows.slice(0, 30).map((f) => (
            <button
              key={f.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onCommit(f.code); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "5px 10px", background: "transparent",
                border: "none", borderBottom: "1px solid #334155",
                color: "#E2E8F0", cursor: "pointer", fontSize: 12,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 600 }}>{f.code}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>
                {f.name || ""}
                {f.fabric_weight_gsm ? ` · ${f.fabric_weight_gsm}gsm` : ""}
                {f.composition_text ? ` · ${f.composition_text}` : ""}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
