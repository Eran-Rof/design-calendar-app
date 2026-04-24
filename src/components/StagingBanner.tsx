// src/components/StagingBanner.tsx
//
// Fixed banner rendered only when VITE_APP_ENV=staging.
// Mounted independently in main.tsx (separate DOM node) so it appears
// regardless of which sub-app is active.

import { appConfig } from "../config/env";

export default function StagingBanner() {
  if (!appConfig.isStaging) return null;

  const readOnlyActive = appConfig.xoroReadOnly || appConfig.shopifyReadOnly;

  return (
    <div
      style={{
        position:      "fixed",
        top:           0,
        left:          0,
        right:         0,
        zIndex:        9999,
        background:    "#FEF3C7",
        borderBottom:  "2px solid #F59E0B",
        padding:       "5px 16px",
        display:       "flex",
        alignItems:    "center",
        gap:           10,
        fontSize:      12,
        fontFamily:    "system-ui, -apple-system, sans-serif",
        color:         "#92400E",
        userSelect:    "none",
      }}
    >
      <span style={{ fontWeight: 700, letterSpacing: "0.06em" }}>⚠ STAGING</span>
      <Dot />
      <span>Inventory Planning Beta</span>
      {readOnlyActive && (
        <>
          <Dot />
          <span>Integrations read-only</span>
        </>
      )}
      {!appConfig.erpWritebackEnabled && (
        <>
          <Dot />
          <span>ERP writeback disabled</span>
        </>
      )}
      <span style={{ marginLeft: "auto", opacity: 0.6 }}>
        design-calendar staging
      </span>
    </div>
  );
}

function Dot() {
  return <span style={{ opacity: 0.4 }}>·</span>;
}
