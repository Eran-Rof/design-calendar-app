// Cross-cutter T7-1 — <DateRangePresets /> chip row.
//
// Drop-in component that sits next to any from/to date input pair.
// Clicking a chip computes the preset's (from, to) and fires onChange.
// The chip whose computed range matches the current (from, to) values
// is rendered in the primary/active style — sticky visual feedback
// across remounts.
//
// All math lives in ./dateRangeMath.ts (pure, unit-tested).

import React from "react";
import { DEFAULT_PRESETS, mergePresets, type Preset, type DatePresetMasterRow } from "./dateRangeMath";

// ── Module-level cache: fetch the operator's Date Presets master once, share
// across every <DateRangePresets/> instance so each date-range picker shows the
// custom presets without N duplicate fetches. ───────────────────────────────
let customPresetsCache: DatePresetMasterRow[] | null = null;
let customPresetsPromise: Promise<DatePresetMasterRow[]> | null = null;
function loadCustomPresets(): Promise<DatePresetMasterRow[]> {
  if (customPresetsCache) return Promise.resolve(customPresetsCache);
  if (typeof fetch !== "function") return Promise.resolve([]);
  if (!customPresetsPromise) {
    customPresetsPromise = Promise.resolve()
      .then(() => fetch("/api/internal/date-presets"))
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { customPresetsCache = Array.isArray(d) ? d : []; return customPresetsCache; })
      .catch(() => { customPresetsCache = []; return customPresetsCache; });
  }
  return customPresetsPromise;
}

type Props = {
  /** Current "from" value as YYYY-MM-DD (or empty). */
  from: string;
  /** Current "to" value as YYYY-MM-DD (or empty). */
  to: string;
  /**
   * Fired when a chip is clicked. Receives the computed `from`/`to`
   * (empty strings for the "custom" preset — caller opens manual
   * pickers in that case) plus the preset object itself.
   */
  onChange: (from: string, to: string, preset: Preset) => void;
  /** Optional override for the preset set. Defaults to DEFAULT_PRESETS. */
  presets?: Preset[];
  /** Chip row alignment within its container. */
  align?: "left" | "right";
  /** Optional style override applied to every chip (or the dropdown). */
  buttonStyle?: React.CSSProperties;
  /**
   * Render style. "chips" (default) = the original wrap-row of chips.
   * "dropdown" = a single compact <select> of the same presets — folds the
   * row into one control so it can sit inline next to the date inputs without
   * wrapping. Same onChange contract (incl. the "custom" empty-string case).
   */
  variant?: "chips" | "dropdown";
};

const chipStyle: React.CSSProperties = {
  background: "transparent",
  color: "#CBD5E1",
  border: "1px solid #334155",
  padding: "4px 10px",
  borderRadius: 16,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const chipActive: React.CSSProperties = {
  ...chipStyle,
  background: "#3B82F6",
  color: "white",
  borderColor: "#3B82F6",
};

const dropdownStyle: React.CSSProperties = {
  background: "#0F172A",
  color: "#E2E8F0",
  border: "1px solid #334155",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  cursor: "pointer",
  outline: "none",
  colorScheme: "dark",
};

export default function DateRangePresets({
  from,
  to,
  onChange,
  presets = DEFAULT_PRESETS,
  align = "left",
  buttonStyle,
  variant = "chips",
}: Props) {
  const today = new Date();

  // Merge in the operator's custom presets (Date Presets master) so every
  // date-range picker shows them. Cached module-wide; re-renders once loaded.
  const [customPresets, setCustomPresets] = React.useState<DatePresetMasterRow[]>(customPresetsCache ?? []);
  React.useEffect(() => {
    let cancel = false;
    void loadCustomPresets().then((d) => { if (!cancel) setCustomPresets(d); });
    return () => { cancel = true; };
  }, []);
  const merged = React.useMemo(() => mergePresets(presets, customPresets), [presets, customPresets]);
  presets = merged;

  // Custom-dropdown open state + click-outside close (hooks always run).
  const [open, setOpen] = React.useState(false);
  const ddRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ddRef.current && !ddRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Dropdown variant — a CUSTOM (div-based) dropdown, not a native <select>:
  // native select option popups render in the OS/generic theme on Windows and
  // can't be reliably dark-themed, so we render our own app-coloured menu.
  if (variant === "dropdown") {
    const active = presets.find((p) => {
      if (p.key === "custom") return false;
      const c = p.compute(today);
      return c.from !== "" && c.to !== "" && c.from === from && c.to === to;
    });
    return (
      <div ref={ddRef} style={{ position: "relative", display: "inline-block" }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{ ...dropdownStyle, display: "inline-flex", alignItems: "center", gap: 6, ...buttonStyle }}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Quick date-range presets"
          data-testid="date-range-presets-dropdown"
        >
          <span>{active?.label ?? "Presets…"}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
        </button>
        {open && (
          <div
            role="listbox"
            style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: "100%",
              background: "#0b1220", border: "1px solid #334155", borderRadius: 8,
              boxShadow: "0 8px 28px rgba(0,0,0,0.45)", zIndex: 1000, maxHeight: 320,
              overflowY: "auto", padding: 4,
            }}
          >
            {presets.map((p) => {
              const c = p.compute(today);
              const isActive = p.key !== "custom" && c.from !== "" && c.to !== "" && c.from === from && c.to === to;
              return (
                <button
                  key={p.key}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-preset-key={p.key}
                  onClick={() => { onChange(c.from, c.to, p); setOpen(false); }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = isActive ? "#3B82F6" : "#1E293B"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = isActive ? "#3B82F6" : "transparent"; }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    background: isActive ? "#3B82F6" : "transparent",
                    color: isActive ? "white" : "#E2E8F0",
                    border: 0, borderRadius: 6, padding: "6px 10px",
                    fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        justifyContent: align === "right" ? "flex-end" : "flex-start",
      }}
      role="group"
      aria-label="Date range presets"
    >
      {presets.map((p) => {
        const computed = p.compute(today);
        // The "custom" preset's compute() returns empty strings —
        // never treat it as active. Only non-custom presets can be the
        // active chip based on a match against current (from, to).
        const isActive =
          p.key !== "custom" &&
          computed.from !== "" &&
          computed.to !== "" &&
          computed.from === from &&
          computed.to === to;

        const style: React.CSSProperties = {
          ...(isActive ? chipActive : chipStyle),
          ...buttonStyle,
        };

        // Tooltip shows the computed range. For "custom" we surface a
        // hint rather than the empty-string sentinel.
        const title =
          p.key === "custom"
            ? "Pick from/to manually"
            : `${computed.from} → ${computed.to}`;

        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange(computed.from, computed.to, p)}
            style={style}
            title={title}
            aria-pressed={isActive}
            data-preset-key={p.key}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
