// ScalePickerCell — native <select> backed by scale_master.
//
// Scale lists are small and finite (entity-scoped scale_master, typically
// <50 rows), so a native select beats an autocomplete: one click and pick.
// Lazy-loads on first focus to avoid hammering the endpoint for every grid
// row at mount.

import React, { useEffect, useState } from "react";
import { searchScales, type ScaleHit } from "../services/costingApi";

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
}

// Module-scoped cache — shared across every grid cell so we hit the
// endpoint once per page load, not once per row.
let scaleCache: ScaleHit[] | null = null;
let scalePromise: Promise<ScaleHit[]> | null = null;

async function loadScales(): Promise<ScaleHit[]> {
  if (scaleCache) return scaleCache;
  if (!scalePromise) {
    scalePromise = searchScales().then((rows) => { scaleCache = rows; return rows; }).catch(() => []);
  }
  return scalePromise;
}

export default function ScalePickerCell({ value, onChange }: Props) {
  const [scales, setScales] = useState<ScaleHit[]>(scaleCache || []);

  useEffect(() => {
    if (scaleCache) return;
    let cancelled = false;
    loadScales().then((rows) => { if (!cancelled) setScales(rows); });
    return () => { cancelled = true; };
  }, []);

  // If the current value isn't in the master list, surface it as a "legacy"
  // option so the cell still reflects what's stored on the line.
  const includesValue = !!value && scales.some((s) => s.scale_code === value);

  return (
    <select
      value={value || ""}
      onChange={(e) => onChange(e.target.value || null)}
      style={{
        width: "100%", padding: "4px 6px", fontSize: 12,
        background: "transparent", border: "1px solid transparent",
        color: "#E2E8F0", outline: "none", colorScheme: "dark",
      }}
    >
      <option value="">—</option>
      {value && !includesValue && <option value={value}>{value} (legacy)</option>}
      {scales.map((s) => (
        <option key={s.id} value={s.scale_code}>
          {s.scale_code}{s.description ? ` — ${s.description}` : ""}
        </option>
      ))}
    </select>
  );
}
