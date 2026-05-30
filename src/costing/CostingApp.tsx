// Costing Module — top-level shell.
//
// Sub-routing via query string (?view=list|edit&id=...) driven by helpers.ts
// — no react-router dependency added. Listens to the custom "costing:navigate"
// event + popstate so back/forward and our own navigate() helper both work.

import React, { useEffect, useState } from "react";
import { TH, setConfirmHandler } from "../utils/theme";
import { ConfirmModal } from "../components/Modal";
import CostingNavBar from "./panels/NavBar";
import ProjectListView from "./views/ProjectListView";
import ProjectEditView from "./views/ProjectEditView";
import SettingsView from "./views/SettingsView";
import { getView } from "./helpers";
import { useCostingStore } from "./store/costingStore";

type ConfirmState = { message: string; action: string; onConfirm: () => void } | null;

export default function CostingApp() {
  const [view, setView] = useState(getView());
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const notice = useCostingStore((s) => s.notice);
  const clearNotice = useCostingStore((s) => s.clearNotice);

  // Wire appConfirm() so calls from anywhere inside the costing tree open
  // the ConfirmModal instead of a native browser dialog.
  useEffect(() => {
    setConfirmHandler((opts) => setConfirmState(opts));
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

  // Auto-dismiss the toast after 5 s. Operator can also dismiss manually.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => clearNotice(), 5000);
    return () => window.clearTimeout(t);
  }, [notice, clearNotice]);

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh",
      background: TH.surfaceHi, fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <CostingNavBar />
      <div style={{ flex: 1, overflowY: "auto" }}>
        {view === "list" && <ProjectListView />}
        {view === "edit" && <ProjectEditView />}
        {view === "settings" && <SettingsView />}
      </div>

      {confirmState && (
        <ConfirmModal
          title="Are you sure?"
          message={confirmState.message}
          confirmLabel={confirmState.action}
          danger
          onConfirm={() => { confirmState.onConfirm(); setConfirmState(null); }}
          onCancel={() => setConfirmState(null)}
        />
      )}

      {notice && (
        <div
          onClick={clearNotice}
          style={{
            position: "fixed", bottom: 24, right: 24, zIndex: 9999,
            background: notice.level === "error" ? "#C53030" : "#2D3748",
            color: "#fff",
            padding: "12px 18px", borderRadius: 10,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            fontSize: 14, maxWidth: 360,
            display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
          }}
          title="Click to dismiss"
        >
          <span style={{ fontSize: 16 }}>{notice.level === "error" ? "⚠️" : "ℹ️"}</span>
          <span>{notice.message}</span>
        </div>
      )}
    </div>
  );
}
