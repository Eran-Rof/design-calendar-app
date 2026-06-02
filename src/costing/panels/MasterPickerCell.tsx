// MasterPickerCell — searchable (type-to-search) dropdown for grid cells
// whose options come from a costing master list (fit / closure / waist /
// comment). Mirrors FabricPickerCell's autocomplete UX but is sourced
// purely from the Zustand store's masters[kind] slice (app_data JSON blob,
// no DB endpoint).
//
// Behavior:
//   - Focus the cell → dropdown opens with the full master list. No typing
//     required (browse mode).
//   - Type → filters the list in-memory (case-insensitive substring).
//   - Pick a row → commits that value.
//   - Type a name that isn't in the master → "+ Add" sentinel saves it to
//     the master (store.addMaster, which persists to app_data) and selects it.
//
// This replaces the plain native-<select> MasterSelectCell for the grid so
// long master lists (closure, fit, …) are searchable. MasterSelectCell is
// kept for any callers that still want the compact native select.

import React, { useEffect, useRef, useState } from "react";
import { useCostingStore, type MasterKind } from "../store/costingStore";

interface Props {
  kind: MasterKind;
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
}

export default function MasterPickerCell({ kind, value, onChange, placeholder }: Props) {
  const entries   = useCostingStore((s) => s.masters[kind]);
  const addMaster = useCostingStore((s) => s.addMaster);
  const setNotice = useCostingStore((s) => s.setNotice);

  const [text, setText] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
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

  const lowerText = text.trim().toLowerCase();
  const matches = entries.filter((m) => !lowerText || m.name.toLowerCase().includes(lowerText));
  const existsExact = entries.some((m) => m.name.toLowerCase() === lowerText);
  const canAdd = lowerText.length > 0 && !existsExact;

  const onCommit = (next: string | null) => {
    setText(next || "");
    onChange(next);
    setOpen(false);
  };

  const onInlineAdd = async () => {
    const v = text.trim();
    if (!v) return;
    setAdding(true);
    try {
      await addMaster(kind, v);
      onChange(v);
      setText(v);
      setOpen(false);
      setNotice(`Added "${v}" to ${kind} master`, "info");
    } catch (e) {
      setNotice(`Could not add ${kind}: ${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={text}
        placeholder={placeholder || "—"}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canAdd) { e.preventDefault(); onInlineAdd(); }
          if (e.key === "Escape") { setOpen(false); setText(value || ""); }
        }}
        onBlur={(e) => {
          // Defer so a click on a dropdown row registers first. Preserve
          // free text so a typed-but-unsaved value still commits to the line.
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
          minWidth: 220, maxHeight: 280, overflowY: "auto",
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

          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onCommit(m.name); }}
              style={{
                ...DROPDOWN_BTN_STYLE,
                fontWeight: m.name === value ? 700 : 400,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >{m.name}</button>
          ))}

          {matches.length === 0 && !canAdd && (
            <div style={{ padding: 8, fontSize: 11, color: "#94A3B8" }}>
              {text ? `No ${kind} matches "${text}".` : `No ${kind} entries yet — type to add one.`}
            </div>
          )}

          {canAdd && (
            <button
              type="button"
              disabled={adding}
              onMouseDown={(e) => { e.preventDefault(); onInlineAdd(); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 10px", background: "#0F172A",
                border: "none", color: "#10B981", cursor: adding ? "wait" : "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >{adding ? "Adding…" : `+ Add "${text.trim()}" to ${kind} master`}</button>
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
