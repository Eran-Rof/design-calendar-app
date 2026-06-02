// StylePickerCell — popover style picker, modelled on the ATS toolbar
// MultiSelectDropdown pattern (single-select variant). Pre-loads the
// full style list once on mount, then filters in-memory as the operator
// types — no async-per-keystroke search.
//
// Same portal-rendered popover as VendorGridCell so the cell's
// overflow:hidden doesn't clip the dropdown.
//
// Free-form add: typing a style code that isn't in the loaded list
// enables a "+ Add new style" row at the bottom (mirrors ColorPickerCell).
// Committing it stores the typed code as-is via onChange — the grid wires
// onChange → updateLine({ style_code }) so a brand-new (not-in-DB) style
// persists exactly like a free-form color. (Restores behavior dropped in
// the #617 picker rewrite.)

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useCostingStore } from "../store/costingStore";
import { usePopoverAnchor } from "../hooks/usePopoverAnchor";
import type { StyleHit } from "../services/costingApi";

interface Props {
  value: string | null;
  onPick: (style: StyleHit) => void;
  onChange?: (next: string) => void;
  placeholder?: string;
  cellStyle?: React.CSSProperties;
}

const EMPTY_STYLES: StyleHit[] = [];

export default function StylePickerCell({ value, onPick, onChange, placeholder }: Props) {
  const styles = useCostingStore((s) => s.stylesForPicker || EMPTY_STYLES);
  const loadStyles = useCostingStore((s) => s.loadStylesForPicker);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { anchorRef, pos } = usePopoverAnchor<HTMLButtonElement>({ open, minWidth: 320 });

  useEffect(() => {
    if (!styles || styles.length === 0) loadStyles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return styles;
    return styles.filter((s) => {
      const code = (s.style_code || "").toLowerCase();
      const name = (s.style_name || "").toLowerCase();
      const desc = (s.description || "").toLowerCase();
      return code.includes(q) || name.includes(q) || desc.includes(q);
    });
  }, [styles, query]);

  // A typed value is "new" when no loaded style has a matching code (so the
  // operator is entering a style not in the DB). Mirrors ColorPickerCell.
  const queryTrim = query.trim();
  const queryIsNew = queryTrim.length > 0
    && !styles.some((s) => (s.style_code || "").toLowerCase() === queryTrim.toLowerCase());

  const commitPick = (style: StyleHit) => {
    setOpen(false);
    onPick(style);
  };

  // Free-form commit — store the typed code as-is. No master link / avg-cost
  // seed (those only apply when picking an existing style via onPick), exactly
  // like a free-form color which doesn't resolve to a master row either.
  const commitNew = (code: string) => {
    if (!code) return;
    setOpen(false);
    onChange?.(code);
  };

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <button
        type="button"
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        title={value ? `Style: ${value}` : "Click to pick a style"}
        style={{
          width: "100%", textAlign: "left",
          background: "transparent",
          color: value ? "#E2E8F0" : "#94A3B8",
          border: `1px ${value ? "solid" : "dashed"} #475569`,
          borderRadius: 3,
          padding: "3px 8px",
          fontSize: 11,
          cursor: "pointer",
          fontWeight: value ? 600 : 400,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 4,
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {value || placeholder || "— pick style —"}
        </span>
        <span style={{ color: "#64748B", fontSize: 9 }}>▾</span>
      </button>
      {open && pos && ReactDOM.createPortal(
        <div
          ref={popRef}
          style={{
            position: "fixed", left: pos.left, top: pos.top, width: pos.width,
            zIndex: 9999, maxHeight: 320, overflowY: "auto",
            background: "#1E293B", border: "1px solid #475569",
            borderRadius: 8, boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{
            padding: 8, borderBottom: "1px solid #334155",
            position: "sticky", top: 0, background: "#1E293B",
          }}>
            <input
              autoFocus
              type="text"
              placeholder="Type to search or add new style…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && queryIsNew) { e.preventDefault(); commitNew(queryTrim); }
              }}
              style={{
                width: "100%", background: "#0F172A", color: "#E2E8F0",
                border: "1px solid #334155", borderRadius: 4,
                padding: "5px 8px", fontSize: 12, outline: "none",
              }}
            />
            <div style={{ marginTop: 4, fontSize: 10, color: "#94A3B8" }}>
              {styles.length === 0
                ? "Loading styles…"
                : `${filtered.length} of ${styles.length} style${styles.length === 1 ? "" : "s"}`}
            </div>
          </div>
          {filtered.length === 0 && styles.length > 0 && !queryIsNew && (
            <div style={{ padding: 12, color: "#94A3B8", fontSize: 12 }}>No matches</div>
          )}
          {filtered.map((s) => {
            const isCurrent = s.style_code === value;
            return (
              <div
                key={s.id}
                role="option"
                tabIndex={0}
                onClick={() => commitPick(s)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitPick(s); } }}
                style={{
                  padding: "6px 12px", cursor: "pointer", fontSize: 12,
                  color: isCurrent ? "#60A5FA" : "#E2E8F0",
                  background: isCurrent ? "#60A5FA11" : undefined,
                  fontWeight: isCurrent ? 600 : undefined,
                  borderBottom: "1px solid #334155",
                }}
                onMouseEnter={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = "#334155"; }}
                onMouseLeave={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >
                <div style={{ fontWeight: 600 }}>{s.style_code || "(no code)"}</div>
                <div style={{ fontSize: 11, color: "#94A3B8" }}>
                  {s.style_name || s.description || ""}
                  {s.gender_code ? ` · ${s.gender_code}` : ""}
                  {s.base_fabric ? ` · ${s.base_fabric}` : ""}
                </div>
              </div>
            );
          })}
          {queryIsNew && onChange && (
            <div
              role="option"
              tabIndex={0}
              onClick={() => commitNew(queryTrim)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitNew(queryTrim); } }}
              style={{
                padding: "8px 12px", cursor: "pointer",
                fontSize: 12, color: "#10B981",
                background: "#10B98111",
                borderTop: filtered.length > 0 ? "1px solid #334155" : undefined,
                fontWeight: 600,
              }}
              title="Uses the typed code as-is for this row (style not in the DB)."
            >
              + Add new style: <strong>{queryTrim}</strong>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
