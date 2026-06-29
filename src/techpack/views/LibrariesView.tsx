// Libraries sub-nav wrapper extracted from TechPack.tsx. Just a
// header + 2-tab strip ("Materials" / "Spec Sheets") that conditionally
// renders one of the two child views passed in as props.
//
// Keeping it slot-shaped (materialsView + specSheetsView passed in)
// lets the parent stay in control of the prop wiring for those
// two heavier components.

import type { ReactNode } from "react";

export type LibrariesTab = "materials" | "specsheets";

export interface LibrariesViewProps {
  libTab: LibrariesTab;
  setLibTab: (t: LibrariesTab) => void;
  materialsView: ReactNode;
  specSheetsView: ReactNode;
}

const TABS: Array<[LibrariesTab, string]> = [
  ["materials", "Materials"],
  ["specsheets", "Spec Sheets"],
];

export function LibrariesView({ libTab, setLibTab, materialsView, specSheetsView }: LibrariesViewProps) {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>Libraries</h2>
      </div>
      {/* Sub-nav tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #334155", marginBottom: 20 }}>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setLibTab(key)}
            style={{
              padding: "10px 20px",
              background: "none",
              border: "none",
              borderBottom: libTab === key ? "2px solid #3B82F6" : "2px solid transparent",
              color: libTab === key ? "#60A5FA" : "#6B7280",
              fontSize: 14,
              fontWeight: libTab === key ? 700 : 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {libTab === "materials" && materialsView}
      {libTab === "specsheets" && specSheetsView}
    </>
  );
}
