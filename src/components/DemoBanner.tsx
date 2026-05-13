// src/components/DemoBanner.tsx
//
// Fixed banner rendered only when VITE_DEMO_MODE=true.
// Mirrors the StagingBanner mounting pattern in main.tsx.

import { appConfig } from "../config/env";

export default function DemoBanner() {
  if (!appConfig.demoMode) return null;
  return (
    <div
      style={{
        position:      "fixed",
        top:           0,
        left:          0,
        right:         0,
        zIndex:        9999,
        background:    "#FCE7F3",
        borderBottom:  "2px solid #EC4899",
        padding:       "5px 16px",
        display:       "flex",
        alignItems:    "center",
        gap:           10,
        fontSize:      12,
        fontFamily:    "system-ui, -apple-system, sans-serif",
        color:         "#9D174D",
        userSelect:    "none",
      }}
    >
      <span style={{ fontWeight: 700, letterSpacing: "0.06em" }}>★ DEMO</span>
      <Dot />
      <span>Sandbox with sample data — actions persist but no external integrations run</span>
      <span style={{ marginLeft: "auto", opacity: 0.6 }}>design-calendar demo</span>
    </div>
  );
}

function Dot() {
  return <span style={{ opacity: 0.4 }}>·</span>;
}
