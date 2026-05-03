// Multi-select dropdown with search + per-option checkboxes. Used by
// the wholesale grid filter strip so the planner can scope to several
// customers / categories / etc. at once instead of one at a time.
// Empty `selected` = no filter (everything passes).

import { useEffect, useMemo, useRef, useState } from "react";
import { S, PAL } from "./styles";

export interface MultiSelectDropdownProps {
  selected: string[];
  onChange: (next: string[]) => void;
  options: Array<{ value: string; label: string }>;
  // Label shown on the trigger button when `selected` is empty.
  allLabel?: string;
  placeholder?: string;
  title?: string;
  minWidth?: number;
  // "compact" shrinks the trigger button (smaller font, tighter
  // padding, lower minWidth) so a row of dropdowns fits in less
  // horizontal space. The popover stays the original size.
  compact?: boolean;
  // Single-select mode — picking an option replaces `selected` with a
  // one-element array (or empty when toggling off the active value).
  // Useful for "pick one of N" UIs like the collapse-mode selector.
  singleSelect?: boolean;
  // Close the popover when the cursor leaves the trigger + popover
  // bounding box. Default off (the popover stays open until the
  // user clicks outside or presses Escape — better for searching
  // through long lists). Useful for short menus where the planner
  // expects the popover to dismiss as soon as they move on.
  closeOnMouseLeave?: boolean;
}

export function MultiSelectDropdown({
  selected, onChange, options, allLabel = "All", placeholder = "Search…", title, minWidth, compact = false, singleSelect = false, closeOnMouseLeave = false,
}: MultiSelectDropdownProps) {
  const triggerMinWidth = minWidth ?? (compact ? 130 : 180);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const buttonLabel = (() => {
    if (selected.length === 0) return allLabel;
    if (selected.length === 1) {
      return options.find((o) => o.value === selected[0])?.label ?? selected[0];
    }
    // Multi-select trigger shows just the count — the allLabel
    // prefix ("None · 3 selected", "All customers · 5 selected")
    // was noisy and the prefix wasn't accurate once anything was
    // chosen anyway.
    return `${selected.length} selected`;
  })();

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  function toggle(value: string) {
    if (singleSelect) {
      if (selectedSet.has(value)) onChange([]);
      else onChange([value]);
      setOpen(false);
      return;
    }
    if (selectedSet.has(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  }

  // Grace-delay state for closeOnMouseLeave so cursor flicker
  // (crossing from trigger to popover, brief slips outside the
  // bounding box) doesn't dismiss the popover before the planner
  // can pick. The delay is cancelled on mouse re-entry.
  const closeTimer = useRef<number | null>(null);
  function cancelCloseTimer() {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }
  useEffect(() => () => cancelCloseTimer(), []);
  return (
    <div
      ref={ref}
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={closeOnMouseLeave ? cancelCloseTimer : undefined}
      onMouseLeave={closeOnMouseLeave ? () => {
        cancelCloseTimer();
        closeTimer.current = window.setTimeout(() => setOpen(false), 600);
      } : undefined}
    >
      <button
        type="button"
        style={{
          ...S.select,
          cursor: "pointer",
          textAlign: "left" as const,
          minWidth: triggerMinWidth,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          ...(compact ? { padding: "5px 10px", fontSize: 12 } : {}),
        }}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{buttonLabel}</span>
        <span style={{ color: PAL.textMuted, fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            background: PAL.panel,
            border: `1px solid ${PAL.border}`,
            borderRadius: 8,
            minWidth: Math.max(triggerMinWidth, 260),
            maxHeight: 380,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{
            padding: 8,
            borderBottom: `1px solid ${PAL.borderFaint}`,
            position: "sticky" as const,
            top: 0,
            background: PAL.panel,
            zIndex: 1,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <input
                autoFocus
                type="text"
                placeholder={placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={(e) => { if (e.currentTarget.value) e.currentTarget.select(); }}
                onMouseUp={(e) => {
                  // Prevent the browser's default mouseup behavior
                  // (caret placement at click position) so the
                  // selection from onFocus's select() — or from this
                  // call on a re-click of an already-focused input —
                  // survives the click.
                  if (e.currentTarget.value) {
                    e.preventDefault();
                    e.currentTarget.select();
                  }
                }}
                style={{ ...S.input, width: "100%", paddingRight: query ? 26 : undefined }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  title="Clear search"
                  aria-label="Clear search"
                  style={{
                    position: "absolute",
                    right: 4,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: PAL.textMuted,
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                >×</button>
              )}
            </div>
            {selected.length > 0 && (
              <button
                type="button"
                style={{ ...S.btnGhost, fontSize: 11, whiteSpace: "nowrap" }}
                onClick={() => onChange([])}
                title="Clear all selections"
              >
                Clear
              </button>
            )}
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          ) : (
            filtered.map((o) => {
              const isSelected = selectedSet.has(o.value);
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onClick={() => toggle(o.value)}
                  onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(o.value); } }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                    color: isSelected ? PAL.text : PAL.textDim,
                    background: isSelected ? PAL.bg : undefined,
                    userSelect: "none",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 16,
                      height: 16,
                      borderRadius: 3,
                      border: `1px solid ${isSelected ? PAL.accent : PAL.border}`,
                      background: isSelected ? PAL.accent : "transparent",
                      color: "#fff",
                      fontSize: 12,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    {isSelected ? "✓" : ""}
                  </span>
                  {o.label}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
