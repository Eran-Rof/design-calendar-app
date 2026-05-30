// SearchableSelect — Cross-cutter T9-1.
//
// A drop-in replacement for native <select> that adds a type-ahead
// filter. Designed for any dropdown whose option list comes from a
// growing DB table (customers, vendors, accounts, employees, styles,
// fabric_codes, etc.) or that exceeds ~10 entries.
//
// Pure controlled component: parent owns `value` + drives state via
// `onChange`. No new deps; ~200 lines of TSX. ARIA combobox pattern
// (role=combobox + role=listbox + aria-activedescendant) preserves
// keyboard + screen-reader semantics that native <select> gives for
// free.
//
// See docs/tangerine/T9-searchable-dropdowns-architecture.md §1 +§3.
//
// Polish 2026-05-30 — operator ask D:
//   • Popover surfaces are now anchored to the Tangerine dark palette
//     (C.bg #0F172A page, C.card #1E293B panel, C.cardBdr #334155
//     borders, C.primary #3B82F6 accent). The previous palette
//     mixed an extra-dark navy (#0b1220) with a bluish-gray hover
//     (#1e3a5f) which read as "gray" against the surrounding card.
//   • Hover state now uses C.primary at 22% alpha; the selected-but-
//     not-highlighted state uses C.primary at 12% alpha, so the
//     popover feels consistent with the rest of the dark UI.
//   • Optional "Add new…" footer row — surfaced when `onAddNew` is
//     supplied. Used by the Style Master classifier dropdowns to let
//     admins commit a never-seen-before group / category / sub-category
//     value without leaving the keyboard.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

export type SearchableSelectOption = {
  value: string;
  label: string;
  /** Optional override; defaults to label. Use to include codes / UUIDs in the filter. */
  searchHaystack?: string;
  disabled?: boolean;
  /** Optional section header for grouped options. */
  group?: string;
};

export type SearchableSelectProps = {
  value: string | null;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Shown when filter yields zero matches. Defaults to "No matches". */
  emptyText?: string;
  inputStyle?: React.CSSProperties;
  /** Defaults to 280px. */
  panelMaxHeight?: number;
  autoFocus?: boolean;
  /**
   * Optional callback. When provided, an "+ Add new…" row is rendered at
   * the bottom of the popover. Clicking it (or pressing Enter while it
   * is highlighted) invokes `onAddNew` with the current search query.
   * Used to gate add-new options behind an admin check at the caller.
   */
  onAddNew?: (query: string) => void;
  /** Label for the add-new row. Defaults to '+ Add "<query>"'. */
  addNewLabel?: (query: string) => string;
};

const VISIBLE_CAP = 200;

// ─────────────────────────────────────────────────────────────────────────
// Tangerine dark palette tokens.
// Mirrors the const block used by every Internal* panel; keeping these
// inline (not imported) preserves the component's "no app-specific deps"
// charter — any consumer outside Tangerine still gets the dark surface
// without having to thread theme through.
// ─────────────────────────────────────────────────────────────────────────
const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  primary: "#3B82F6",
  // Translucent overlays for hover + selected states. rgba so they layer
  // on top of any panel background without introducing a new opaque tone.
  primarySoft: "rgba(59, 130, 246, 0.22)",
  primaryFaint: "rgba(59, 130, 246, 0.12)",
};

const DEFAULT_INPUT_STYLE: React.CSSProperties = {
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px",
  borderRadius: 4,
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  marginTop: 2,
  background: C.card,
  border: `1px solid ${C.cardBdr}`,
  borderRadius: 4,
  zIndex: 1000,
  overflowY: "auto",
  listStyle: "none",
  padding: 0,
  margin: 0,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
};

const OPTION_STYLE_BASE: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  color: C.text,
  cursor: "pointer",
  userSelect: "none",
};

const GROUP_HEADER_STYLE: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: C.bg,
  color: C.textMuted,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  padding: "4px 10px",
  borderBottom: `1px solid ${C.cardBdr}`,
  zIndex: 1,
};

const FOOTER_STYLE: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 11,
  color: C.textMuted,
  borderTop: `1px solid ${C.cardBdr}`,
  fontStyle: "italic",
  background: C.card,
  position: "sticky",
  bottom: 0,
};

const ADD_NEW_STYLE: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  color: C.primary,
  cursor: "pointer",
  userSelect: "none",
  borderTop: `1px solid ${C.cardBdr}`,
  background: C.card,
  position: "sticky",
  bottom: 0,
  fontWeight: 600,
};

function haystack(o: SearchableSelectOption): string {
  return o.searchHaystack ?? o.label;
}

function defaultAddNewLabel(q: string): string {
  const trimmed = q.trim();
  return trimmed ? `+ Add "${trimmed}"` : "+ Add new…";
}

export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  value,
  onChange,
  options,
  placeholder = "",
  disabled = false,
  required = false,
  emptyText = "No matches",
  inputStyle,
  panelMaxHeight = 280,
  autoFocus = false,
  onAddNew,
  addNewLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  // When the add-new row is highlighted we use -1 as the sentinel so the
  // existing enabledIdxs logic keeps working untouched for the option list.
  const ADD_NEW_IDX = -1;
  const [addNewHighlighted, setAddNewHighlighted] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => options.find(o => o.value === value) ?? null,
    [options, value],
  );

  // Filter is case-insensitive includes against haystack(option).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => haystack(o).toLowerCase().includes(q));
  }, [options, query]);

  const capped = useMemo(
    () => (filtered.length > VISIBLE_CAP ? filtered.slice(0, VISIBLE_CAP) : filtered),
    [filtered],
  );

  // Indexes of selectable (non-disabled) options in `capped`.
  const enabledIdxs = useMemo(
    () => capped.map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0),
    [capped],
  );

  // Whether to surface the add-new row. We require either an explicit
  // typed query (so we have something to add) OR an empty result set —
  // in both cases adding a fresh value is the natural next step.
  const showAddNew = !!onAddNew && (query.trim().length > 0 || capped.length === 0);

  // When the visible list changes, clamp the highlight back into range
  // (and skip to next enabled if currently on a disabled item).
  useEffect(() => {
    if (enabledIdxs.length === 0) {
      // No selectable options — fall back to the add-new row if available.
      if (showAddNew) setAddNewHighlighted(true);
      else setAddNewHighlighted(false);
      setHighlightIdx(0);
      return;
    }
    setAddNewHighlighted(false);
    setHighlightIdx(prev => {
      if (prev < 0) return enabledIdxs[0]!;
      if (prev >= capped.length) return enabledIdxs[0]!;
      if (capped[prev]?.disabled) return enabledIdxs[0]!;
      return prev;
    });
  }, [capped, enabledIdxs, showAddNew]);

  // Click-outside closes (mousedown — same pattern as ExportButton).
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const openPanel = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    setAddNewHighlighted(false);
    // Default highlight to the currently selected option if it's
    // present in the (unfiltered, no-query) visible list.
    const idx = selected
      ? options.findIndex(o => o.value === selected.value)
      : -1;
    setHighlightIdx(idx >= 0 && idx < VISIBLE_CAP && !options[idx]?.disabled ? idx : 0);
  }, [disabled, options, selected]);

  const commit = useCallback(
    (opt: SearchableSelectOption) => {
      if (opt.disabled) return;
      onChange(opt.value);
      setOpen(false);
      setQuery("");
      setAddNewHighlighted(false);
    },
    [onChange],
  );

  const commitAddNew = useCallback(() => {
    if (!onAddNew) return;
    const trimmed = query.trim();
    onAddNew(trimmed);
    setOpen(false);
    setQuery("");
    setAddNewHighlighted(false);
  }, [onAddNew, query]);

  const moveHighlight = useCallback(
    (delta: 1 | -1) => {
      const hasOptions = enabledIdxs.length > 0;
      if (!hasOptions && !showAddNew) return;

      if (!hasOptions) {
        // Only the add-new row is selectable; nothing to move to.
        setAddNewHighlighted(true);
        return;
      }

      if (addNewHighlighted) {
        // Leaving the add-new row.
        setAddNewHighlighted(false);
        setHighlightIdx(
          delta === 1
            ? enabledIdxs[0]!
            : enabledIdxs[enabledIdxs.length - 1]!,
        );
        return;
      }

      setHighlightIdx(prev => {
        const pos = enabledIdxs.indexOf(prev);
        if (pos < 0) return enabledIdxs[0]!;
        const next = pos + delta;
        if (next >= enabledIdxs.length) {
          if (showAddNew) {
            setAddNewHighlighted(true);
            return prev;
          }
          return enabledIdxs[0]!;
        }
        if (next < 0) {
          if (showAddNew) {
            setAddNewHighlighted(true);
            return prev;
          }
          return enabledIdxs[enabledIdxs.length - 1]!;
        }
        return enabledIdxs[next]!;
      });
    },
    [enabledIdxs, showAddNew, addNewHighlighted],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        openPanel();
        return;
      }
      moveHighlight(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openPanel();
        return;
      }
      moveHighlight(-1);
      return;
    }
    if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (addNewHighlighted && onAddNew) {
        commitAddNew();
        return;
      }
      const opt = capped[highlightIdx];
      if (opt && !opt.disabled) commit(opt);
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery("");
        setAddNewHighlighted(false);
      }
      return;
    }
    if (e.key === "Tab") {
      // Allow native focus-shift; close without commit.
      if (open) {
        setOpen(false);
        setQuery("");
        setAddNewHighlighted(false);
      }
      return;
    }
  };

  const displayValue = open ? query : (selected?.label ?? "");

  const mergedInputStyle: React.CSSProperties = {
    ...DEFAULT_INPUT_STYLE,
    ...(inputStyle ?? {}),
    ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : {}),
  };

  const listboxId = useId();
  const activeOptionId = addNewHighlighted
    ? `${listboxId}-add-new`
    : open && capped[highlightIdx]
      ? `${listboxId}-opt-${highlightIdx}`
      : undefined;

  return (
    <div
      ref={wrapperRef}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls={listboxId}
      style={{ position: "relative", width: "100%" }}
    >
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        placeholder={selected ? selected.label : placeholder}
        disabled={disabled}
        required={required}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        onFocus={() => { if (!open) openPanel(); }}
        onClick={() => { if (!open) openPanel(); }}
        onChange={e => { setQuery(e.target.value); if (!open) setOpen(true); setAddNewHighlighted(false); }}
        onKeyDown={onKeyDown}
        style={mergedInputStyle}
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          style={{ ...PANEL_STYLE, maxHeight: panelMaxHeight }}
        >
          {capped.length === 0 && !showAddNew && (
            <li
              role="option"
              aria-selected={false}
              aria-disabled={true}
              style={{ ...OPTION_STYLE_BASE, color: C.textMuted, cursor: "default", fontStyle: "italic" }}
            >
              {emptyText}
            </li>
          )}
          {capped.map((opt, i) => {
            const prev = i > 0 ? capped[i - 1] : null;
            const showGroup = !!opt.group && opt.group !== prev?.group;
            const isHighlighted = !addNewHighlighted && i === highlightIdx;
            const isSelected = selected?.value === opt.value;
            const itemStyle: React.CSSProperties = {
              ...OPTION_STYLE_BASE,
              ...(opt.disabled ? { color: "#64748B", cursor: "not-allowed" } : {}),
              ...(isHighlighted && !opt.disabled ? { background: C.primarySoft } : {}),
              ...(isSelected && !isHighlighted ? { background: C.primaryFaint } : {}),
            };
            return (
              <React.Fragment key={`${opt.value}-${i}`}>
                {showGroup && (
                  <li role="presentation" style={GROUP_HEADER_STYLE}>
                    {opt.group}
                  </li>
                )}
                <li
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={!!opt.disabled}
                  onMouseEnter={() => { if (!opt.disabled) { setHighlightIdx(i); setAddNewHighlighted(false); } }}
                  onMouseDown={e => {
                    // mousedown so we beat the input's blur+click-outside.
                    e.preventDefault();
                    if (!opt.disabled) commit(opt);
                  }}
                  style={itemStyle}
                >
                  {opt.label}
                </li>
              </React.Fragment>
            );
          })}
          {filtered.length > VISIBLE_CAP && (
            <li role="presentation" style={FOOTER_STYLE}>
              showing {VISIBLE_CAP} of {filtered.length} — refine your search
            </li>
          )}
          {showAddNew && (
            <li
              id={`${listboxId}-add-new`}
              role="option"
              aria-selected={addNewHighlighted}
              onMouseEnter={() => setAddNewHighlighted(true)}
              onMouseLeave={() => setAddNewHighlighted(false)}
              onMouseDown={e => {
                e.preventDefault();
                commitAddNew();
              }}
              style={{
                ...ADD_NEW_STYLE,
                background: addNewHighlighted ? C.primarySoft : C.card,
              }}
            >
              {(addNewLabel ?? defaultAddNewLabel)(query)}
            </li>
          )}
        </ul>
      )}
    </div>
  );
};

export default SearchableSelect;
