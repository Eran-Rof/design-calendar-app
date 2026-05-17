// Outlook-themed color palette + the FolderIcon SVG used only by the
// TechPack email panel. Originally allocated on every render of the
// inline tpEmailPanel() — moving them to module scope avoids the
// per-render churn and gives Phase 2 (when the email panel splits
// into its own component) a clean import path.

import React from "react";

/** Outlook-aware palette for the email panel chrome. */
export const EMAIL_COLORS = {
  bg0:        "#0F172A",
  bg1:        "#1E293B",
  bg2:        "#253347",
  bg3:        "#2D3D52",
  border:     "#334155",
  border2:    "#3E4F66",
  text1:      "#F1F5F9",
  text2:      "#94A3B8",
  text3:      "#6B7280",
  outlook:    "#0078D4",
  outlookLt:  "#106EBE",
  outlookDim: "rgba(0,120,212,0.15)",
  error:      "#EF4444",
  errorDim:   "rgba(239,68,68,0.15)",
  success:    "#34D399",
  info:       "#60A5FA",
  warning:    "#FBBF24",
};

/** Folder glyph for the email panel's account list. */
export function FolderIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 14" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M1 2.5C1 1.67 1.67 1 2.5 1H5.5L7 2.5H13.5C14.33 2.5 15 3.17 15 4V11.5C15 12.33 14.33 13 13.5 13H2.5C1.67 13 1 12.33 1 11.5V2.5Z"
        stroke={color}
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}
