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

  // Dropdown variant — one compact <select> instead of the chip row. The
  // option whose computed range matches (from, to) is shown as selected.
  if (variant === "dropdown") {
    const activeKey =
      presets.find((p) => {
        if (p.key === "custom") return false;
        const c = p.compute(today);
        return c.from !== "" && c.to !== "" && c.from === from && c.to === to;
      })?.key ?? "";
    return (
      <select
        value={activeKey}
        onChange={(e) => {
          const p = presets.find((pp) => pp.key === e.target.value);
          if (!p) return;
          const c = p.compute(today);
          // "custom" returns empty strings — same contract as the chips.
          onChange(c.from, c.to, p);
        }}
        style={{ ...dropdownStyle, ...buttonStyle }}
        aria-label="Date range presets"
        title="Quick date-range presets"
        data-testid="date-range-presets-dropdown"
      >
        <option value="">Presets…</option>
        {presets.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
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
