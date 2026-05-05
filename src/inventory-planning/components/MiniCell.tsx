// Compact key/value cell used in detail drawers (forecast detail,
// ecom override, supply allocation). Smaller padding + monospace
// value than StatCell so a drawer can stack many of them in a grid
// without overpowering the form below.

import { S, PAL } from "./styles";

export function MiniCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ ...S.infoCell, padding: "10px 12px" }}>
      <div style={S.infoLabel}>{label}</div>
      <div style={{ ...S.infoValue, fontFamily: "monospace", color: accent ?? PAL.text }}>{value}</div>
    </div>
  );
}
