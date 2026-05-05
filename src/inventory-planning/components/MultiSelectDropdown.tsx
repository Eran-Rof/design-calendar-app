// Multi-select dropdown with search + per-option checkboxes. Used by
// the wholesale grid filter strip so the planner can scope to several
// customers / categories / etc. at once instead of one at a time.
// Empty `selected` = no filter (everything passes).
//
// Popover is rendered via React Portal anchored to the trigger via
// getBoundingClientRect — this prevents any ancestor with
// overflow:hidden / overflow:auto from clipping it or trapping its
// stacking context. The previous inline absolutely-positioned popover
// had ghost-click issues whenever the dropdown lived inside a panel
// that scrolled.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { S, PAL } from "./styles";

export interface MultiSelectDropdownProps {
  selected: string[];
  onChange: (next: string[]) => void;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
  placeholder?: string;
  title?: string;
  minWidth?: number;
  compact?: boolean;
  singleSelect?: boolean;
  closeOnMouseLeave?: boolean;
}

export function MultiSelectDropdown({
  selected, onChange, options, allLabel = "All", placeholder = "Search…", title, minWidth, compact = false, singleSelect = false, closeOnMouseLeave = false,
}: MultiSelectDropdownProps) {
  const triggerMinWidth = minWidth ?? (compact ? 130 : 180);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; minWidth: number; maxHeight: number } | null>(null);

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
    return `${selected.length} selected`;
  })();

  // Position the popover relative to the trigger when it opens, and
  // refresh on scroll / resize so it tracks if the page moves.
  // Clamps the position so the popover always fits inside the
  // viewport: shifts left when it would overflow the right edge,
  // flips above the trigger when it would overflow the bottom (and
  // there's more room above), and caps maxHeight to the available
  // space so the search input + first few options stay reachable
  // even when the trigger is near a corner.
  useEffect(() => {
    if (!open) { setAnchor(null); return; }
    const update = () => {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const PAD = 8;
      const GAP = 4;
      const ABS_MAX_H = 380;
      const MIN_USABLE_H = 180;
      const popMinW = Math.max(r.width, 260);
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Horizontal: prefer left-aligned with trigger; shift left when
      // the popover would overflow the right edge. Floor at PAD so it
      // doesn't disappear off the left edge on tiny viewports.
      let left = r.left;
      if (left + popMinW > vw - PAD) left = Math.max(PAD, vw - popMinW - PAD);

      // Vertical: prefer below; flip above when below has less room
      // than what's needed (ABS_MAX_H or MIN_USABLE_H minimum).
      const spaceBelow = vh - r.bottom - GAP - PAD;
      const spaceAbove = r.top - GAP - PAD;
      let top: number;
      let maxHeight: number;
      if (spaceBelow >= MIN_USABLE_H || spaceBelow >= spaceAbove) {
        top = r.bottom + GAP;
        maxHeight = Math.max(MIN_USABLE_H, Math.min(ABS_MAX_H, spaceBelow));
      } else {
        maxHeight = Math.max(MIN_USABLE_H, Math.min(ABS_MAX_H, spaceAbove));
        top = Math.max(PAD, r.top - GAP - maxHeight);
      }
      setAnchor({ top, left, minWidth: popMinW, maxHeight });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // Focus the search input shortly after the popover mounts. The
  // portal can render after a tick; calling .focus() in a layout
  // effect with no value to select is the most reliable approach.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
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

  // Grace-delay state for closeOnMouseLeave so cursor flicker doesn't
  // dismiss the popover before the planner can pick. Mouse-leave on
  // either the trigger OR the popover starts the timer; mouse-enter
  // on either cancels.
  const closeTimer = useRef<number | null>(null);
  function cancelCloseTimer() {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }
  function scheduleClose() {
    cancelCloseTimer();
    closeTimer.current = window.setTimeout(() => setOpen(false), 600);
  }
  useEffect(() => () => cancelCloseTimer(), []);

  return (
    <>
      <button
        ref={triggerRef}
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
        onMouseEnter={closeOnMouseLeave ? cancelCloseTimer : undefined}
        onMouseLeave={closeOnMouseLeave ? scheduleClose : undefined}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{buttonLabel}</span>
        <span style={{ color: PAL.textMuted, fontSize: 10 }}>▾</span>
      </button>
      {open && anchor && createPortal(
        <div
          ref={popoverRef}
          onMouseEnter={closeOnMouseLeave ? cancelCloseTimer : undefined}
          onMouseLeave={closeOnMouseLeave ? scheduleClose : undefined}
          style={{
            position: "fixed",
            top: anchor.top,
            left: anchor.left,
            zIndex: 1000,
            background: PAL.panel,
            border: `1px solid ${PAL.border}`,
            borderRadius: 8,
            minWidth: anchor.minWidth,
            // Driven by the viewport-clamping in the position effect
            // so the popover always fits on-screen, flipping above
            // the trigger when there's not enough room below.
            maxHeight: anchor.maxHeight,
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{
            padding: 8,
            borderBottom: `1px solid ${PAL.borderFaint}`,
            background: PAL.panel,
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexShrink: 0,
          }}>
            <input
              ref={inputRef}
              className="ip-search-input"
              type="text"
              placeholder={placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={(e) => {
                // Select-all on initial focus only — once focused,
                // clicks inside the input position the cursor
                // normally (so the planner can click between
                // characters without losing their place).
                if (e.currentTarget.value) {
                  const el = e.currentTarget;
                  setTimeout(() => el.select(), 0);
                }
              }}
              style={{ ...S.input, flex: 1, minWidth: 0 }}
            />
            {query && (
              <button
                type="button"
                onMouseDown={(e) => {
                  // Pre-empt the input's blur. preventDefault stops
                  // the button from stealing focus, so the input's
                  // selection / caret stay put while we wipe the
                  // query. Doing the wipe here (not onClick) means
                  // the popover doesn't ghost-shift between mousedown
                  // and click.
                  e.preventDefault();
                  setQuery("");
                  inputRef.current?.focus();
                }}
                title="Clear search"
                aria-label="Clear search"
                style={{
                  height: 30,
                  padding: "0 10px",
                  border: `1px solid ${PAL.border}`,
                  background: PAL.bg,
                  color: PAL.text,
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 700,
                  lineHeight: 1,
                  borderRadius: 6,
                  flexShrink: 0,
                }}
              >Clear</button>
            )}
            {selected.length > 0 && (
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onChange([]); }}
                title="Clear all selections"
                style={{ ...S.btnGhost, fontSize: 11, whiteSpace: "nowrap", height: 30 }}
              >
                Reset
              </button>
            )}
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
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
                    onMouseDown={(e) => { e.preventDefault(); toggle(o.value); }}
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
        </div>,
        document.body,
      )}
    </>
  );
}
