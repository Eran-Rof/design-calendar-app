// FabricPickerCell — multi-select autocomplete for the Fabric column.
//
// Task 3 — sources ONLY from Tangerine fabric_codes (via
// /api/internal/costing/search/fabrics). The legacy costing-owned fabric
// master (costing_fabrics app_data blob) is no longer unioned in.
//
// Behavior:
//   - Multi-select: a line can carry several fabric codes. Selected codes
//     render as removable chips inside the cell; the dropdown lets the
//     operator add more.
//   - Click / focus the cell → dropdown opens with the first 25 active
//     fabric_codes. No typing required (browse mode).
//   - Type → debounced DB search filters fabric_codes (code/name ILIKE).
//   - Free-add: typing a fabric code not on the master enables a "+ Add"
//     row that simply appends the typed string to the selection (same
//     free-form UX as StylePickerCell's "+ Add new style" — the code is NOT
//     written to fabric_codes table, it's stored as-is on the line).
//
// Value contract: `value` is the array of selected fabric codes; `onChange`
// receives the next array. The grid persists it to costing_lines.fabric_codes
// and mirrors the first element into the legacy fabric_code column.

import React, { useEffect, useRef, useState } from "react";
import { searchFabrics, type FabricHit } from "../services/costingApi";

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
}

export default function FabricPickerCell({ value, onChange }: Props) {
  const selected = Array.isArray(value) ? value : [];
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [dbRows, setDbRows] = useState<FabricHit[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // Debounced DB search. Fires unconditionally — the handler returns the
  // first 25 active fabric_codes when q is empty so the operator can browse.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const out = await searchFabrics(text, controller.signal);
        setDbRows(out);
      } catch { /* silent */ }
      finally { setLoading(false); }
    }, 200);
    return () => { window.clearTimeout(t); controller.abort(); };
  }, [text, open]);

  const selectedLower = new Set(selected.map((s) => s.toLowerCase().trim()));
  // Hide already-selected codes from the dropdown so picking twice is a no-op.
  const availableRows = dbRows.filter((r) => !selectedLower.has((r.code || "").toLowerCase().trim()));

  const lowerText = text.trim().toLowerCase();
  const existsInDb = dbRows.some((r) => (r.code || "").toLowerCase() === lowerText || (r.name || "").toLowerCase() === lowerText);
  const alreadySelected = selectedLower.has(lowerText);
  const canAdd = lowerText.length > 0 && !existsInDb && !alreadySelected;

  const addCode = (code: string) => {
    const c = (code || "").trim();
    if (!c) return;
    if (selectedLower.has(c.toLowerCase())) { setText(""); return; }
    onChange([...selected, c]);
    setText("");
  };

  const removeCode = (code: string) => {
    onChange(selected.filter((c) => c !== code));
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <div
        onClick={() => setOpen(true)}
        style={{
          display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center",
          minHeight: 26, padding: "2px 4px", cursor: "text",
        }}
      >
        {selected.map((c) => (
          <span
            key={c}
            style={{
              display: "inline-flex", alignItems: "center", gap: 3,
              background: "#334155", color: "#E2E8F0",
              border: "1px solid #475569", borderRadius: 10,
              padding: "1px 6px", fontSize: 10, whiteSpace: "nowrap",
            }}
          >
            {c}
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeCode(c); }}
              title={`Remove ${c}`}
              style={{
                background: "transparent", border: "none", color: "#F87171",
                cursor: "pointer", padding: 0, fontSize: 11, lineHeight: 1,
              }}
            >×</button>
          </span>
        ))}
        <input
          value={text}
          placeholder={selected.length === 0 ? "Fabric" : ""}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canAdd) { e.preventDefault(); addCode(text); }
            // Backspace on an empty input removes the last chip.
            if (e.key === "Backspace" && text === "" && selected.length > 0) {
              e.preventDefault();
              removeCode(selected[selected.length - 1]);
            }
          }}
          style={{
            flex: 1, minWidth: 50, padding: "2px 2px", fontSize: 12,
            background: "transparent", border: "none",
            color: "#E2E8F0", outline: "none",
          }}
        />
      </div>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 50,
          minWidth: 280, maxHeight: 280, overflowY: "auto",
          background: "#1E293B", border: "1px solid #475569",
          borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          marginTop: 2,
        }}>
          {loading && <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>Searching…</div>}

          {availableRows.map((f) => (
            <button
              key={`db_${f.id}`}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); addCode(f.code || ""); }}
              style={DROPDOWN_BTN_STYLE}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <div style={{ fontWeight: 600 }}>{f.code}</div>
              <div style={{ fontSize: 11, color: "#94A3B8" }}>
                {f.name || ""}
                {f.composition_text ? ` · ${f.composition_text}` : ""}
              </div>
            </button>
          ))}

          {!loading && availableRows.length === 0 && !canAdd && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>
              {text ? `No fabric matches "${text}".` : "No more fabrics — type a code to free-add."}
            </div>
          )}

          {canAdd && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); addCode(text); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 10px", background: "#0F172A",
                border: "none", color: "#10B981", cursor: "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >+ Add fabric: <strong>{text.trim()}</strong></button>
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
