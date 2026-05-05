// Editable per-row unit cost. Blank input → clears the override and reverts
// to the auto-derived ATS avg cost (or item_cost) on the next refresh.
// `overridden` controls the visual hint so planners can see at a glance
// which rows have a manual cost vs. the auto-fill.

import { useEffect, useRef, useState } from "react";
import { PAL } from "../styles";

export function UnitCostCell({ value, overridden, onSave }: {
  value: number | null;
  overridden: boolean;
  onSave: (cost: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [str, setStr] = useState(value != null ? value.toFixed(2) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setStr(value != null ? value.toFixed(2) : "");
  }, [value, editing]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    const cost = trimmed === "" ? null : Number(trimmed);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) { setErr(true); setEditing(false); return; }
    if (cost === value) { setEditing(false); return; }
    setErr(false);
    setSaving(true);
    try { await onSave(cost); } catch { setErr(true); } finally { setSaving(false); setEditing(false); }
  }

  const colorRaw = err ? PAL.red : (value != null ? PAL.accent2 : PAL.textMuted);
  const title = overridden
    ? "Planner override — click to edit, clear to revert to ATS avg"
    : "Auto-filled from ATS avg cost — click to override";

  // Display state: plain text "$5.00" right-justified in the cell so it
  // matches the aggregate row's rendering exactly (no input box, no
  // gap between $ and number). Click flips into the editable input.
  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
        title={title}
        style={{
          display: "inline-block",
          fontFamily: "monospace",
          fontSize: 13,
          color: colorRaw,
          fontWeight: 600,
          fontStyle: overridden ? "italic" : "inherit",
          textDecoration: "inherit",
          textDecorationColor: "currentColor",
          cursor: "pointer",
          padding: "2px 4px",
          borderRadius: 4,
          opacity: saving ? 0.5 : 1,
        }}
      >
        {value != null ? `$${value.toFixed(2)}` : "—"}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      data-unitcost="1"
      type="text"
      inputMode="decimal"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") { setStr(value != null ? value.toFixed(2) : ""); setEditing(false); }
      }}
      placeholder="—"
      title={title}
      style={{
        width: 64,
        background: PAL.panel,
        color: colorRaw,
        border: `1px solid ${err ? PAL.red : PAL.accent2}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
        fontStyle: "inherit",
        fontWeight: "inherit",
        textDecoration: "inherit",
      }}
    />
  );
}
