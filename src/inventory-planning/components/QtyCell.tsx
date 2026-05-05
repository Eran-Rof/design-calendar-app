// Click-to-edit qty cell. Renders the formatted "5,000" value as
// plain text by default; clicking flips to a raw editable input.
// Enter or blur commits, Escape cancels. Same UX pattern the
// wholesale grid uses on Unit Cost. Lives in components/ so any
// panel that needs an editable positive-integer cell can pick it
// up directly.

import { useEffect, useState } from "react";
import { PAL } from "./styles";

export function QtyCell({ value, busy, onSave }: {
  value: number;
  busy: boolean;
  onSave: (next: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [str, setStr] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => { if (!editing) setStr(String(value)); }, [value, editing]);

  async function commit(raw: string) {
    const trimmed = raw.trim().replace(/,/g, "");
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      setErr(true); setEditing(false); return;
    }
    setErr(false);
    if (n === value) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(n); } catch { setErr(true); } finally { setSaving(false); setEditing(false); }
  }

  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={() => { if (!busy && !saving) setEditing(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!busy && !saving) setEditing(true); } }}
        title="Click to edit qty"
        style={{
          display: "inline-block",
          fontFamily: "monospace",
          fontSize: 13,
          color: err ? PAL.red : PAL.text,
          fontWeight: 600,
          cursor: (busy || saving) ? "wait" : "pointer",
          padding: "2px 6px",
          borderRadius: 4,
          opacity: (busy || saving) ? 0.5 : 1,
          minWidth: 60,
          textAlign: "right" as const,
        }}
      >{value.toLocaleString()}</span>
    );
  }

  return (
    <input
      autoFocus
      type="text"
      inputMode="numeric"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") { setStr(String(value)); setEditing(false); }
      }}
      style={{
        width: 80,
        background: PAL.panel,
        color: err ? PAL.red : PAL.text,
        border: `1px solid ${err ? PAL.red : PAL.accent}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
      }}
    />
  );
}
