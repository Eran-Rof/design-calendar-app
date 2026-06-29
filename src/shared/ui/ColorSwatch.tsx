// src/shared/ui/ColorSwatch.tsx
//
// Renders a colour square for a colour name / hex. Two-tone "A/B" colourways
// (e.g. "Grey/Black") render as a diagonal half-and-half split.
//
// Half resolution precedence:
//   1. Explicit hexA / hexB props (Color A / Color B from the Color Master).
//      When hexB (or hexA) is given, render that explicit two-tone split.
//   2. Otherwise fall back to splitting the NAME ("Grey/Black") and resolving
//      each half via colorHex().
// A plain colour uses the explicit/stored hex if given, else a best-effort hex
// from the name.

import { colorHex, splitColorName } from "../colorHex";

function normHex(h?: string | null): string | null {
  if (!h) return null;
  const bare = String(h).trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(bare)) return null;
  return `#${bare.toLowerCase()}`;
}

export function ColorSwatch({
  name,
  hex,
  hexA,
  hexB,
  size = 16,
  title,
}: {
  name?: string | null;
  hex?: string | null;
  /** Explicit Color A hex (#RRGGBB). Takes precedence over name-parsing. */
  hexA?: string | null;
  /** Explicit Color B hex (#RRGGBB). When set, renders an explicit two-tone split. */
  hexB?: string | null;
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

  const explicitA = normHex(hexA) || normHex(hex);
  const explicitB = normHex(hexB);
  const parts = splitColorName(name);

  // Explicit two-tone: an explicit Color B was chosen → half/half from the
  // explicit hexes (precedence over name-parsing).
  if (explicitB) {
    const a = explicitA || colorHex(parts[0]) || "#7a7a7a";
    return (
      <span
        title={title || name || ""}
        style={{
          ...base,
          background: `linear-gradient(135deg, ${a} 0 50%, ${explicitB} 50% 100%)`,
          border: "1px solid rgba(255,255,255,0.3)",
        }}
      />
    );
  }

  // Name-based two-tone: half/half diagonal split, each half from its name.
  // An explicit Color A (if given) overrides the parsed first half.
  if (parts.length >= 2) {
    const a = explicitA || colorHex(parts[0]) || "#7a7a7a";
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

  // Plain colour: explicit/stored hex, else derive from the name.
  const single = explicitA || colorHex(name);
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
