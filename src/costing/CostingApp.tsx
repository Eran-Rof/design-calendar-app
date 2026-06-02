// Costing Module — top-level shell.
//
// Sub-routing via query string (?view=list|edit&id=...) driven by helpers.ts
// — no react-router dependency added. Listens to the custom "costing:navigate"
// event + popstate so back/forward and our own navigate() helper both work.

import React, { useEffect, useState } from "react";
import { TH, setConfirmHandler } from "../utils/theme";
import { WarnHost, confirmDialog } from "../shared/ui/warn";
import CostingNavBar from "./panels/NavBar";
import ProjectListView from "./views/ProjectListView";
import ProjectEditView from "./views/ProjectEditView";
import SettingsView from "./views/SettingsView";
import RfqListView from "./views/RfqListView";
import RfqEditView from "./views/RfqEditView";
import { getView } from "./helpers";

export default function CostingApp() {
  const [view, setView] = useState(getView());

  // Wire appConfirm() through the canonical Tangerine confirm surface
  // (src/shared/ui/warn → confirmDialog) so every costing yes/no prompt
  // matches the ATS / PO-WIP layout + app colors. The legacy
  // appConfirm(message, action, onConfirm) signature is preserved — we just
  // route it to confirmDialog() and fire onConfirm on a positive result.
  useEffect(() => {
    setConfirmHandler(({ message, action, onConfirm }) => {
      void confirmDialog(message, { confirmText: action }).then((ok) => {
        if (ok) onConfirm();
      });
    });
  }, []);

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
    <div className="costing-app" style={{
      display: "flex", flexDirection: "column", height: "100vh",
      background: TH.surfaceHi, fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* Strip the native up/down spinner steppers from every number input in
          the costing subtree. Scoped to .costing-app so it can't affect other
          apps, and applied at the root so any number field added later inherits
          it without per-input styling. */}
      <style>{`
        .costing-app input[type="number"]::-webkit-outer-spin-button,
        .costing-app input[type="number"]::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .costing-app input[type="number"] {
          -moz-appearance: textfield;
          appearance: textfield;
        }
      `}</style>
      <CostingNavBar />
      <div style={{ flex: 1, overflowY: "auto" }}>
        {view === "list" && <ProjectListView />}
        {view === "edit" && <ProjectEditView />}
        {view === "settings" && <SettingsView />}
        {view === "rfq-list" && <RfqListView />}
        {view === "rfq-edit" && <RfqEditView />}
      </div>

      {/* Canonical Tangerine warn surface — renders the shared toast +
          confirm modal (same layout + app colors as ATS / PO-WIP). Mounted
          once here since the Costing app boots standalone (not under the
          Tangerine shell where the other <WarnHost/> lives). */}
      <WarnHost />
    </div>
  );
}
