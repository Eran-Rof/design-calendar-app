// Editable Buy qty cell on the planning grid. Comma-formats the
// idle display ("10,000") and shows raw digits while focused so
// keystrokes don't fight commas. Empty input clears the planned
// buy. Lives in components/cells/ so the grid file stays scoped to
// rendering / filtering / aggregation.

import { useEffect, useRef, useState } from "react";
import { PAL } from "../styles";

export function BuyCell({ value, onSave }: { value: number | null; onSave: (qty: number | null) => Promise<void> }) {
  const [str, setStr] = useState(value != null ? String(value) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!focused.current) setStr(value != null ? String(value) : "");
  }, [value]);

  async function commit(raw: string) {
    const trimmed = raw.trim().replace(/,/g, "");
    const qty = trimmed === "" ? null : Number(trimmed);
    if (qty !== null && (!Number.isFinite(qty) || !Number.isInteger(qty))) { setErr(true); focused.current = false; setIsFocused(false); return; }
    if (qty === value || (qty == null && value == null)) { focused.current = false; setIsFocused(false); return; }
    setErr(false);
    setSaving(true);
    try { await onSave(qty); } catch { setErr(true); } finally { setSaving(false); focused.current = false; setIsFocused(false); }
  }

  // Display "10,000" when idle; raw "10000" while editing so commas
  // don't interfere with parsing.
  const renderValue = isFocused ? str : (value != null ? value.toLocaleString() : "");
  return (
    <input
      data-buycell="1"
      type="text"
      inputMode="numeric"
      value={renderValue}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      style={{
        width: 72,
        background: "transparent",
        color: err ? PAL.red : str ? PAL.green : PAL.textDim,
        border: `1px solid ${err ? PAL.red : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
        fontStyle: "inherit",
        textDecoration: "inherit",
        fontWeight: "inherit",
      }}
      onFocus={(e) => {
        focused.current = true; setIsFocused(true);
        // Seed editable state with raw integer (no commas).
        setStr(value != null ? String(value) : "");
        setTimeout(() => e.target.select(), 0);
        e.target.style.borderColor = err ? PAL.red : PAL.green;
        e.target.style.background = PAL.panel;
      }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : "transparent"; e.target.style.background = "transparent"; }}
    />
  );
}
