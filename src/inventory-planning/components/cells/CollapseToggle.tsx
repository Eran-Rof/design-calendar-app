// Compact checkbox-as-pill toggle, used in the planning grid's
// collapse strip and the System Suggestions on/off control.

import { PAL } from "../styles";

export function CollapseToggle({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", padding: "2px 6px", borderRadius: 4, background: active ? `${PAL.accent}22` : "transparent", border: `1px solid ${active ? PAL.accent : PAL.border}`, color: active ? PAL.accent : PAL.textDim }}>
      <input type="checkbox" checked={active} onChange={onToggle} style={{ accentColor: PAL.accent }} />
      {label}
    </label>
  );
}
