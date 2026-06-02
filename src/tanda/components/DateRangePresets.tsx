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
import { DEFAULT_PRESETS, type Preset } from "./dateRangeMath";

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
  /** Optional style override applied to every chip. */
  buttonStyle?: React.CSSProperties;
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

export default function DateRangePresets({
  from,
  to,
  onChange,
  presets = DEFAULT_PRESETS,
  align = "left",
  buttonStyle,
}: Props) {
  const today = new Date();

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
