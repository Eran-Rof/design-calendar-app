// Reusable integer cell for inline qty edits (Buyer / Override). Blank
// or non-numeric input commits 0. Negative values allowed when the column
// permits it (Override can subtract).

import { useEffect, useRef, useState } from "react";
import { PAL } from "../styles";

export function IntCell({ value, accent, allowNegative, onSave }: {
  value: number;
  accent: string;
  allowNegative: boolean;
  onSave: (qty: number) => Promise<void>;
}) {
  const [str, setStr] = useState(value === 0 ? "" : (allowNegative && value > 0 ? "+" : "") + String(value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!focused.current) setStr(value === 0 ? "" : (allowNegative && value > 0 ? "+" : "") + String(value));
  }, [value, allowNegative]);

  async function commit(raw: string) {
    const trimmed = raw.trim().replace(/[+,]/g, "");
    const qty = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || (!allowNegative && qty < 0)) {
      setErr(true); focused.current = false; setIsFocused(false); return;
    }
    if (qty === value) { focused.current = false; setIsFocused(false); return; }
    setErr(false);
    setSaving(true);
    try { await onSave(qty); } catch { setErr(true); } finally { setSaving(false); focused.current = false; setIsFocused(false); }
  }

  const color = err ? PAL.red : value !== 0 ? accent : PAL.textMuted;
  // Display value: comma-formatted "5,000" when idle, raw "5000" while
  // editing so the planner doesn't wrestle commas during keystrokes.
  // Sign prefix (+/−) preserved when allowNegative.
  const renderValue = isFocused ? str : (value === 0 ? "" : (allowNegative && value > 0 ? "+" : "") + value.toLocaleString());
  return (
    <input
      type="text"
      inputMode={allowNegative ? "text" : "numeric"}
      value={renderValue}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      style={{
        width: 72,
        background: "transparent",
        color,
        border: `1px solid ${err ? PAL.red : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
        // Inherit italic + underline from the parent <tr> so aggregate
        // rows' rolled-up styling reaches the editable Buyer / Override
        // cells. Native inputs don't inherit these by default.
        fontStyle: "inherit",
        textDecoration: "inherit",
        fontWeight: "inherit",
      }}
      onFocus={(e) => {
        focused.current = true; setIsFocused(true);
        // Seed the editable string from the current value (raw, no commas).
        const seed = value === 0 ? "" : (allowNegative && value > 0 ? "+" : "") + String(value);
        setStr(seed);
        // Defer .select() so React's value swap from formatted to raw
        // applies before the selection range is set.
        setTimeout(() => e.target.select(), 0);
        e.target.style.borderColor = err ? PAL.red : accent;
        e.target.style.background = PAL.panel;
      }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : "transparent"; e.target.style.background = "transparent"; }}
    />
  );
}
