// DynamicSearchInput — Operator ask #8 universal primitive.
//
// Drop-in search box for any panel that wants type-as-you-go filtering
// without an explicit Search button.
//
// Two usage modes:
//
//   1. Controlled (preferred for panels that already own the search state):
//        const { value, debouncedValue, setValue } = useDebouncedSearch();
//        <DynamicSearchInput value={value} onChange={setValue} />
//        useEffect(() => { load(debouncedValue); }, [debouncedValue]);
//
//   2. Uncontrolled (quick adoption when the parent only needs the debounced
//      result):
//        <DynamicSearchInput onDebouncedChange={(q) => setQuery(q)} />
//
// Styling matches the existing Tangerine panel inputs (dark card surface,
// 1px slate border, 13px text). Inline styles only — the repo doesn't ship
// Tailwind utility classes in `src/tanda/`.
//
// Accessibility:
//   - `aria-label` is the canonical label (placeholder is decorative).
//   - Esc clears the field. Enter is a no-op (filter is already live).
//   - The clear button has `aria-label="Clear search"` and only renders
//     while there's something to clear.

import React, { useEffect, useRef } from "react";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";

const C = {
  bg: "#0b1220",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  border: "#334155",
  focusBorder: "#3B82F6",
};

const wrapperStyle: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  width: "100%",
  maxWidth: 320,
};

const inputBaseStyle: React.CSSProperties = {
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.border}`,
  padding: "6px 28px 6px 30px",
  borderRadius: 4,
  fontSize: 13,
  width: "100%",
  outline: "none",
  boxSizing: "border-box",
};

const iconStyle: React.CSSProperties = {
  position: "absolute",
  left: 8,
  top: "50%",
  transform: "translateY(-50%)",
  color: C.textMuted,
  pointerEvents: "none",
  fontSize: 13,
  lineHeight: 1,
};

const clearBtnStyle: React.CSSProperties = {
  position: "absolute",
  right: 4,
  top: "50%",
  transform: "translateY(-50%)",
  background: "transparent",
  border: 0,
  color: C.textMuted,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: "2px 6px",
  borderRadius: 3,
};

export type DynamicSearchInputProps = {
  /** Controlled value. If omitted, the component manages its own state. */
  value?: string;
  /** Called on every keystroke with the new raw (sync) value. */
  onChange?: (next: string) => void;
  /**
   * Called after `debounceMs` of inactivity with the latest value.
   * Required in uncontrolled mode if the parent wants to react to typing.
   * Optional in controlled mode (parent already debounces its own state).
   */
  onDebouncedChange?: (next: string) => void;
  /** Debounce window in ms. Defaults to 200 to match GlobalSearchPalette. */
  debounceMs?: number;
  /** Placeholder text. Defaults to "Search…". */
  placeholder?: string;
  /** Accessible label. Defaults to the placeholder. */
  ariaLabel?: string;
  /** Optional input style overrides (merged on top of the defaults). */
  inputStyle?: React.CSSProperties;
  /** Optional wrapper style overrides (merged on top of the defaults). */
  wrapperStyle?: React.CSSProperties;
  /** Auto-focus the input on mount. Defaults to false. */
  autoFocus?: boolean;
  /** Disabled state. */
  disabled?: boolean;
  /** Test hook. */
  "data-testid"?: string;
};

export function DynamicSearchInput(props: DynamicSearchInputProps): React.ReactElement {
  const {
    value: controlledValue,
    onChange,
    onDebouncedChange,
    debounceMs = 200,
    placeholder = "Search…",
    ariaLabel,
    inputStyle: inputStyleOverride,
    wrapperStyle: wrapperStyleOverride,
    autoFocus = false,
    disabled = false,
  } = props;

  const isControlled = controlledValue !== undefined;

  // Internal debounce slot — only used when uncontrolled. In controlled
  // mode the parent owns debouncing (either via useDebouncedSearch or its
  // own logic).
  const internal = useDebouncedSearch("", debounceMs);
  const displayValue = isControlled ? (controlledValue ?? "") : internal.value;

  // Fire onDebouncedChange whenever the internal debounced value lands. We
  // skip the initial empty-string emit so a freshly-mounted uncontrolled
  // input doesn't spuriously trigger a "search for ''" on the parent.
  const lastEmittedRef = useRef<string>("");
  useEffect(() => {
    if (isControlled) return;
    if (internal.debouncedValue === lastEmittedRef.current) return;
    lastEmittedRef.current = internal.debouncedValue;
    onDebouncedChange?.(internal.debouncedValue);
  }, [internal.debouncedValue, isControlled, onDebouncedChange]);

  const inputRef = useRef<HTMLInputElement | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    if (isControlled) {
      onChange?.(next);
    } else {
      internal.setValue(next);
      onChange?.(next);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && displayValue.length > 0) {
      e.preventDefault();
      doClear();
    } else if (e.key === "Enter") {
      // Filter is already live — explicitly swallow so the keystroke doesn't
      // submit a surrounding <form> by accident.
      e.preventDefault();
    }
  }

  function doClear() {
    if (isControlled) {
      onChange?.("");
    } else {
      internal.clear();
      lastEmittedRef.current = "";
      onDebouncedChange?.("");
    }
    inputRef.current?.focus();
  }

  const mergedWrapper: React.CSSProperties = wrapperStyleOverride
    ? { ...wrapperStyle, ...wrapperStyleOverride }
    : wrapperStyle;
  const mergedInput: React.CSSProperties = inputStyleOverride
    ? { ...inputBaseStyle, ...inputStyleOverride }
    : inputBaseStyle;

  return (
    <div style={mergedWrapper}>
      <span aria-hidden="true" style={iconStyle}>
        {/* Unicode magnifying glass — keeps the primitive dep-free. */}
        {"\u{1F50D}"}
      </span>
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        value={displayValue}
        onChange={handleChange}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        style={mergedInput}
        autoComplete="off"
        spellCheck={false}
        data-testid={props["data-testid"]}
      />
      {displayValue.length > 0 && !disabled && (
        <button
          type="button"
          onClick={doClear}
          aria-label="Clear search"
          title="Clear (Esc)"
          style={clearBtnStyle}
        >
          {"×"}
        </button>
      )}
    </div>
  );
}

export default DynamicSearchInput;
