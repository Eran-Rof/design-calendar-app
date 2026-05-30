// Costing Module — top nav
import React from "react";
import { TH } from "../../utils/theme";
import { navigate, getView } from "../helpers";

export default function CostingNavBar() {
  const view = getView();

  // "New" navigates to the projects list AND fires a custom event the list
  // view listens for to open its New-project modal. Keeps the modal state
  // local to ProjectListView without store coupling.
  const onNew = () => {
    if (view !== "list") navigate("list");
    // Defer so ProjectListView has rendered before we fire the event.
    setTimeout(() => window.dispatchEvent(new CustomEvent("costing:new-project")), 0);
  };

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
        Costing
      </span>
      <div style={{ display: "flex", gap: 2 }}>
        <button
          onClick={() => navigate("list")}
          style={navBtn(view === "list")}
        >
          Projects
        </button>
        <button
          onClick={onNew}
          style={navBtn(false)}
        >
          + New
        </button>
      </div>
    </div>
  );
}

function navBtn(active: boolean): React.CSSProperties {
  return {
    background: active ? TH.primary : "transparent",
    color: active ? "#fff" : "rgba(255,255,255,0.75)",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    transition: "all 0.15s",
  };
}
