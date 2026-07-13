// Editable System forecast cell. Shows the override value when one is
// set (highlighted yellow + italic), otherwise the computed system
// suggestion in muted color. Tooltip carries the audit trail
// "Changed from X to Y by USER on DATE" so planners know who/when.
// Clearing the field overrides System to 0 (so Final drops that
// contribution); re-typing the suggested value clears the override.

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
  // Show a bare "0" only when it's an explicit override-to-zero; a
  // naturally-zero suggestion stays blank so it reads as "no forecast".
  const display = (v: number): string => (v === 0 && !(overriddenAt != null && v !== original)) ? "" : String(v);
  const [str, setStr] = useState(display(value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(display(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, original, overriddenAt]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    // Clearing the field = override System to 0 so Final = Buyer +
    // Override (the planner is explicitly removing the system forecast).
    // To restore the suggestion, re-type it — that clears the override.
    let nextOverride: number | null;
    if (trimmed === "") {
      nextOverride = 0;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) { setErr(true); focused.current = false; return; }
      nextOverride = n;
    }
    // Typing (or clearing to) the suggested value means "no override" —
    // revert to the clean suggested state instead of stamping an
    // override equal to it.
    if (nextOverride === original) nextOverride = null;
    // No-op when nothing actually changes (avoids a needless write +
    // audit-timestamp bump).
    if ((nextOverride == null && !overridden) || nextOverride === value) { focused.current = false; return; }
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
    titleParts.push(`(clear to zero it; re-type ${original.toLocaleString()} to restore the suggestion)`);
  } else {
    titleParts.push(`System suggestion: ${original.toLocaleString()}. Type a value to override, or clear to set 0.`);
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
