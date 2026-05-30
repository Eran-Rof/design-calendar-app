// ColorPickerCell — popover color picker modelled on the planning app's
// TbdColorCell (src/inventory-planning/components/cells/TbdColorCell.tsx).
//
// Trigger button → popover with search input + scrollable list. When a
// styleCode is provided, the options come from /search/colors with that
// style — so only colors the style actually exists in show up. Operator-
// added colors (costing_extra_colors) are always merged in. Typing a
// brand-new color enables a "+ Add new color" row at the bottom that
// saves to extras + selects it.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { searchColors } from "../services/costingApi";
import { useCostingStore } from "../store/costingStore";

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
  /**
   * Scope colors to a specific style (only colors that exist on SKUs under
   * this style in ip_item_master). Falls back to all colors when null.
   */
  styleCode?: string | null;
}

export default function ColorPickerCell({ value, onChange, styleCode }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const addExtraColor = useCostingStore((s) => s.addExtraColor);
  const setNotice     = useCostingStore((s) => s.setNotice);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  // Load colors once the popover opens. Re-fires when styleCode changes so
  // picking a new style re-scopes the available colors. The handler already
  // honours the empty-query case (returns the full distinct list).
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const out = await searchColors("", { styleCode, signal: controller.signal });
        setRows(out);
      } catch { /* silent */ }
      finally { setLoading(false); }
    })();
    return () => controller.abort();
  }, [open, styleCode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => c.toLowerCase().includes(q));
  }, [rows, query]);

  const queryTrim = query.trim();
  const queryIsNew = queryTrim.length > 0
    && !rows.some((c) => c.toLowerCase() === queryTrim.toLowerCase());

  const commitPick = (next: string) => {
    onChange(next || null);
    setOpen(false);
  };

  const commitNew = async (name: string) => {
    if (busy || !name) return;
    setBusy(true);
    try {
      await addExtraColor(name);
      onChange(name);
      setOpen(false);
      setNotice(`Saved "${name}" for future autocomplete`, "info");
    } catch (e) {
      setNotice(`Could not save color: ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={value ? `Color: ${value}` : "Click to pick a color"}
        style={{
          width: "100%", textAlign: "left",
          background: "transparent",
          color: value ? "#E2E8F0" : "#94A3B8",
          border: `1px ${value ? "solid" : "dashed"} #475569`,
          borderRadius: 3,
          padding: "3px 8px",
          fontSize: 11,
          cursor: "pointer",
          fontWeight: value ? 500 : 400,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 4,
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {value || "— pick color —"}
        </span>
        <span style={{ color: "#64748B", fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0,
            zIndex: 60, minWidth: 220, maxHeight: 320, overflowY: "auto",
            background: "#1E293B", border: "1px solid #475569",
            borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{
            padding: 8, borderBottom: "1px solid #334155",
            position: "sticky", top: 0, background: "#1E293B",
          }}>
            <input
              autoFocus
              type="text"
              placeholder="Type to search or add new color…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && queryIsNew) { e.preventDefault(); void commitNew(queryTrim); }
              }}
              style={{
                width: "100%", background: "#0F172A", color: "#E2E8F0",
                border: "1px solid #334155", borderRadius: 4,
                padding: "5px 8px", fontSize: 12, outline: "none",
              }}
            />
            <div style={{ marginTop: 4, fontSize: 10, color: "#94A3B8", lineHeight: 1.4 }}>
              {loading
                ? "Loading…"
                : (styleCode
                  ? `${filtered.length} color${filtered.length === 1 ? "" : "s"} for ${styleCode}`
                  : `${filtered.length} color${filtered.length === 1 ? "" : "s"} (pick a style to scope)`)}
            </div>
          </div>
          {!loading && filtered.length === 0 && !queryIsNew && (
            <div style={{ padding: 12, color: "#94A3B8", fontSize: 12 }}>
              {styleCode
                ? "No colors found for this style — type one to add NEW."
                : "No colors yet — type one to add."}
            </div>
          )}
          {filtered.map((c) => {
            const isCurrent = c === value;
            return (
              <div
                key={c}
                role="option"
                tabIndex={0}
                onClick={() => commitPick(c)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitPick(c); } }}
                style={{
                  padding: "6px 12px", cursor: "pointer", fontSize: 12,
                  color: isCurrent ? "#60A5FA" : "#E2E8F0",
                  background: isCurrent ? "#60A5FA11" : undefined,
                  fontWeight: isCurrent ? 600 : undefined,
                  borderBottom: "1px solid #334155",
                }}
                onMouseEnter={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = "#334155"; }}
                onMouseLeave={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >{c}</div>
            );
          })}
          {queryIsNew && (
            <div
              role="option"
              tabIndex={0}
              onClick={() => commitNew(queryTrim)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitNew(queryTrim); } }}
              style={{
                padding: "8px 12px", cursor: busy ? "wait" : "pointer",
                fontSize: 12, color: "#10B981",
                background: "#10B98111",
                borderTop: filtered.length > 0 ? "1px solid #334155" : undefined,
                fontWeight: 600,
              }}
              title="Saves to costing_extra_colors so other rows can pick it later."
            >
              {busy ? "Saving…" : <>+ Add new color: <strong>{queryTrim}</strong></>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
