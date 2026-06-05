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
          style={navBtn(view === "list" || view === "edit")}
        >
          Projects
        </button>
        <button
          onClick={onNew}
          style={navBtn(false)}
        >
          + New
        </button>
        <button
          onClick={() => navigate("rfq-list")}
          style={navBtn(view === "rfq-list" || view === "rfq-edit")}
        >
          RFQs
        </button>
        <button
          onClick={() => navigate("messages")}
          style={navBtn(view === "messages")}
        >
          Messages
        </button>
        <button
          onClick={() => navigate("settings")}
          style={navBtn(view === "settings")}
        >
          Masters
        </button>
      </div>

      {/* Vendor portal links — open the standalone /vendor app in a new tab
          (separate Supabase Auth session, so it must not replace the costing
          tab). */}
      <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
        <a
          href="/vendor"
          target="_blank"
          rel="noopener noreferrer"
          style={linkBtn}
          title="Open the vendor portal in a new tab"
        >
          Vendor Portal ↗
        </a>
        <a
          href="/vendor/onboarding"
          target="_blank"
          rel="noopener noreferrer"
          style={linkBtn}
          title="Open vendor onboarding in a new tab"
        >
          Vendor Onboarding ↗
        </a>
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "transparent",
  color: "rgba(255,255,255,0.75)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 6,
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 400,
  cursor: "pointer",
  textDecoration: "none",
  whiteSpace: "nowrap",
  transition: "all 0.15s",
};

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
