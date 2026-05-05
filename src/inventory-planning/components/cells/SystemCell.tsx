// Editable System forecast cell. Shows the override value when one is
// set (highlighted yellow + italic), otherwise the computed system
// suggestion in muted color. Tooltip carries the audit trail
// "Changed from X to Y by USER on DATE" so planners know who/when.
// Empty input clears the override (reverts to suggestion).

import { useEffect, useRef, useState } from "react";
import { PAL } from "../styles";

export function SystemCell({ value, original, overriddenAt, overriddenBy, onSave }: {
  value: number;
  original: number;
  overriddenAt: string | null;
  overriddenBy: string | null;
  onSave: (qty: number | null) => Promise<void>;
}) {
  const overridden = overriddenAt != null && value !== original;
  const [str, setStr] = useState(value === 0 ? "" : String(value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value === 0 ? "" : String(value));
  }, [value]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    // Empty / 0 = clear the override (revert to suggestion). Anything
    // else becomes the override; we pass even "= original" as a no-op
    // so the audit timestamp doesn't bump when the planner re-types
    // the same value.
    let nextOverride: number | null;
    if (trimmed === "" || trimmed === "0") {
      nextOverride = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) { setErr(true); focused.current = false; return; }
      if (n === original && !overridden) { focused.current = false; return; }
      nextOverride = n;
    }
    setErr(false);
    setSaving(true);
    try { await onSave(nextOverride); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  const titleParts: string[] = [];
  if (overridden) {
    titleParts.push(`Changed from ${original.toLocaleString()} to ${value.toLocaleString()}`);
    if (overriddenBy) titleParts.push(`by ${overriddenBy}`);
    if (overriddenAt) {
      const when = new Date(overriddenAt);
      if (!isNaN(when.getTime())) titleParts.push(`on ${when.toLocaleString()}`);
    }
    titleParts.push("(empty input reverts to suggestion)");
  } else {
    titleParts.push(`System suggestion: ${original.toLocaleString()}. Type a value to override.`);
  }
  const title = titleParts.join(" · ");
  const baseColor = err ? PAL.red : overridden ? PAL.yellow : PAL.textMuted;

  return (
    <input
      type="text"
      inputMode="numeric"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      title={title}
      style={{
        width: 64,
        background: overridden ? `${PAL.yellow}11` : "transparent",
        color: baseColor,
        border: `1px solid ${err ? PAL.red : overridden ? `${PAL.yellow}66` : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
        // Override forces italic + bold for planner-changed cells.
        // Otherwise inherit so aggregate rows can apply their italic +
        // underline styling without losing the override visual.
        fontStyle: overridden ? "italic" : "inherit",
        fontWeight: overridden ? 700 : "inherit",
        textDecoration: "inherit",
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : PAL.yellow; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : overridden ? `${PAL.yellow}66` : "transparent"; e.target.style.background = overridden ? `${PAL.yellow}11` : "transparent"; }}
    />
  );
}
