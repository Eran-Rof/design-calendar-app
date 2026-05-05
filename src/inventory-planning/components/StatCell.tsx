// Card-style summary stat: small label on top, big monospace value
// below. Used across every workbench's header strip
// (run totals, accuracy KPIs, scenario diff, supply reconciliation,
// execution batch summary, ecom totals).
//
// Was duplicated byte-for-byte in six panels — extracted here so a
// styling tweak only needs one find.

import { S, PAL } from "./styles";

export function StatCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={S.statCard}>
      <div style={{ fontSize: 11, color: PAL.textMuted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ?? PAL.text, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}
