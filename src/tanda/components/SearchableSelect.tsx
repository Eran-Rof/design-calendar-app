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
};

const VISIBLE_CAP = 200;

const DEFAULT_INPUT_STYLE: React.CSSProperties = {
  background: "#0b1220",
  color: "#F1F5F9",
  border: "1px solid #334155",
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
  background: "#0b1220",
  border: "1px solid #334155",
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
  color: "#F1F5F9",
  cursor: "pointer",
  userSelect: "none",
};

const GROUP_HEADER_STYLE: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "#1e293b",
  color: "#94A3B8",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  padding: "4px 10px",
  borderBottom: "1px solid #334155",
  zIndex: 1,
};

const FOOTER_STYLE: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 11,
  color: "#94A3B8",
  borderTop: "1px solid #334155",
  fontStyle: "italic",
  background: "#0b1220",
  position: "sticky",
  bottom: 0,
};

function haystack(o: SearchableSelectOption): string {
  return o.searchHaystack ?? o.label;
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
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);

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

  // When the visible list changes, clamp the highlight back into range
  // (and skip to next enabled if currently on a disabled item).
  useEffect(() => {
    if (enabledIdxs.length === 0) {
      setHighlightIdx(0);
      return;
    }
    setHighlightIdx(prev => {
      if (prev < 0) return enabledIdxs[0]!;
      if (prev >= capped.length) return enabledIdxs[0]!;
      if (capped[prev]?.disabled) return enabledIdxs[0]!;
      return prev;
    });
  }, [capped, enabledIdxs]);

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
    },
    [onChange],
  );

  const moveHighlight = useCallback(
    (delta: 1 | -1) => {
      if (enabledIdxs.length === 0) return;
      setHighlightIdx(prev => {
        const pos = enabledIdxs.indexOf(prev);
        if (pos < 0) return enabledIdxs[0]!;
        const next = (pos + delta + enabledIdxs.length) % enabledIdxs.length;
        return enabledIdxs[next]!;
      });
    },
    [enabledIdxs],
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
      const opt = capped[highlightIdx];
      if (opt && !opt.disabled) commit(opt);
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery("");
      }
      return;
    }
    if (e.key === "Tab") {
      // Allow native focus-shift; close without commit.
      if (open) {
        setOpen(false);
        setQuery("");
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
  const activeOptionId =
    open && capped[highlightIdx] ? `${listboxId}-opt-${highlightIdx}` : undefined;

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
        onChange={e => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onKeyDown={onKeyDown}
        style={mergedInputStyle}
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          style={{ ...PANEL_STYLE, maxHeight: panelMaxHeight }}
        >
          {capped.length === 0 && (
            <li
              role="option"
              aria-selected={false}
              aria-disabled={true}
              style={{ ...OPTION_STYLE_BASE, color: "#94A3B8", cursor: "default", fontStyle: "italic" }}
            >
              {emptyText}
            </li>
          )}
          {capped.map((opt, i) => {
            const prev = i > 0 ? capped[i - 1] : null;
            const showGroup = !!opt.group && opt.group !== prev?.group;
            const isHighlighted = i === highlightIdx;
            const isSelected = selected?.value === opt.value;
            const itemStyle: React.CSSProperties = {
              ...OPTION_STYLE_BASE,
              ...(opt.disabled ? { color: "#64748B", cursor: "not-allowed" } : {}),
              ...(isHighlighted && !opt.disabled ? { background: "#1e3a5f" } : {}),
              ...(isSelected && !isHighlighted ? { background: "#15233a" } : {}),
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
                  onMouseEnter={() => { if (!opt.disabled) setHighlightIdx(i); }}
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
        </ul>
      )}
    </div>
  );
};

export default SearchableSelect;
