import React from "react";
import { TH } from "../../utils/theme";
import { useGS1Store, type GS1Tab } from "../store/gs1Store";

const TABS: Array<{ id: GS1Tab; label: string }> = [
  { id: "company",   label: "Company Setup" },
  { id: "upc",       label: "UPC Master" },
  { id: "scale",     label: "Scale Master" },
  { id: "gtins",     label: "Pack GTINs" },
  { id: "upload",    label: "Packing List" },
  { id: "labels",    label: "Label Batches" },
  { id: "templates", label: "Label Templates" },
  { id: "cartons",   label: "Carton Labels" },
  { id: "receiving", label: "Receiving" },
];

export default function GS1NavBar() {
  const activeTab   = useGS1Store(s => s.activeTab);
  const setActiveTab = useGS1Store(s => s.setActiveTab);

  return (
    <div style={{
      background: TH.header,
      color: "#fff",
      display: "flex",
      alignItems: "center",
      padding: "0 16px",
      height: 52,
      boxShadow: `0 2px 8px ${TH.shadow}`,
      flexShrink: 0,
      gap: 8,
    }}>
      <a href="/" style={{ color: "#fff", textDecoration: "none", fontSize: 13, marginRight: 16, opacity: 0.7 }}>
        ← PLM
      </a>
      <span style={{ fontWeight: 700, fontSize: 15, marginRight: 20 }}>
        GS1 Prepack Labels
      </span>
      <div style={{ display: "flex", gap: 2 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: activeTab === tab.id ? TH.primary : "transparent",
              color: activeTab === tab.id ? "#fff" : "rgba(255,255,255,0.75)",
              border: "none",
              borderRadius: 6,
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
