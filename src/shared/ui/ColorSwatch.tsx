// src/shared/ui/ColorSwatch.tsx
//
// Renders a colour square for a colour name / hex. Two-tone "A/B" colourways
// (e.g. "Grey/Black") render as a diagonal half-and-half split, each half
// resolved from its name via colorHex(). A plain colour uses the stored hex if
// given, else a best-effort hex from the name.

import { colorHex, splitColorName } from "../colorHex";

export function ColorSwatch({
  name,
  hex,
  size = 16,
  title,
}: {
  name?: string | null;
  hex?: string | null;
  size?: number;
  title?: string;
}) {
  const base: React.CSSProperties = {
    display: "inline-block",
    width: size,
    height: size,
    borderRadius: 4,
    verticalAlign: "middle",
    flexShrink: 0,
    boxSizing: "border-box",
  };
  const parts = splitColorName(name);

  // Two-tone: half/half diagonal split.
  if (parts.length >= 2) {
    const a = colorHex(parts[0]) || "#7a7a7a";
    const b = colorHex(parts[1]) || "#7a7a7a";
    return (
      <span
        title={title || name || ""}
        style={{
          ...base,
          background: `linear-gradient(135deg, ${a} 0 50%, ${b} 50% 100%)`,
          border: "1px solid rgba(255,255,255,0.3)",
        }}
      />
    );
  }

  // Plain colour: stored hex, else derive from the name.
  const single = (hex && hex.trim()) || colorHex(name);
  return (
    <span
      title={title || name || hex || ""}
      style={{
        ...base,
        background: single || "transparent",
        border: single ? "1px solid rgba(255,255,255,0.3)" : "1px solid #334155",
      }}
    />
  );
}

export default ColorSwatch;
