// Costing Module — top-level shell.
//
// Sub-routing via query string (?view=list|edit&id=...) driven by helpers.ts
// — no react-router dependency added. Listens to the custom "costing:navigate"
// event + popstate so back/forward and our own navigate() helper both work.

import React, { useEffect, useState } from "react";
import { TH } from "../utils/theme";
import CostingNavBar from "./panels/NavBar";
import ProjectListView from "./views/ProjectListView";
import ProjectEditView from "./views/ProjectEditView";
import { getView } from "./helpers";

export default function CostingApp() {
  const [view, setView] = useState(getView());

  useEffect(() => {
    const refresh = () => setView(getView());
    window.addEventListener("popstate", refresh);
    window.addEventListener("costing:navigate", refresh as EventListener);
    return () => {
      window.removeEventListener("popstate", refresh);
      window.removeEventListener("costing:navigate", refresh as EventListener);
    };
  }, []);

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh",
      background: TH.surfaceHi, fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <CostingNavBar />
      <div style={{ flex: 1, overflowY: "auto" }}>
        {view === "list" && <ProjectListView />}
        {view === "edit" && <ProjectEditView />}
      </div>
    </div>
  );
}
