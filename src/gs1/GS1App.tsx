import React, { useState } from "react";
import { TH } from "../utils/theme";
import { useGS1Store, type GS1Tab } from "./store/gs1Store";
import { NavDrawer, DRAWER_W_OPEN, DRAWER_W_CLOSED } from "../tanda/NavDrawer";
import { GS1_MODULES, GS1_SECTIONS } from "./gs1Modules";
import CompanySetupPanel from "./panels/CompanySetupPanel";
import UpcMasterPanel from "./panels/UpcMasterPanel";
import ScaleMasterPanel from "./panels/ScaleMasterPanel";
import PackGtinMasterPanel from "./panels/PackGtinMasterPanel";
import PackingListUploadPanel from "./panels/PackingListUploadPanel";
import PAUnpackerPanel from "./panels/PAUnpackerPanel";
import LabelBatchPanel from "./panels/LabelBatchPanel";
import CartonPanel from "./panels/CartonPanel";
import ReceivingPanel from "./panels/ReceivingPanel";
import LabelTemplatesPanel from "./panels/LabelTemplatesPanel";
import ExceptionsPanel from "./panels/ExceptionsPanel";
import EdiWorkflowPanel from "./panels/EdiWorkflowPanel";
import CatalogPanel from "./panels/CatalogPanel";
import NotificationsPage from "../components/notifications/NotificationsPage";
import NotificationsShell from "../components/notifications/NotificationsShell";
import { useAppUnreadCount } from "../components/notifications/useAppUnreadCount";
import { GlobalSearchPaletteAuto } from "../components/GlobalSearchPalette";
import { supabaseClient } from "../utils/supabase";
// Tangerine P10-5 — Top-bar entity switcher.
import EntitySwitcher from "../components/EntitySwitcher";
import { useDocumentTitle } from "../shared/useDocumentTitle";

// Browser-tab labels per GS1 tab (mirrors the NavBar TABS labels).
const GS1_TAB_LABELS: Record<string, string> = {
  company:       "Company Setup",
  upc:           "UPC Master",
  scale:         "Scale Master",
  gtins:         "Pack GTINs",
  catalog:       "Styles Catalog",
  upload:        "Packing List",
  pa_unpacker:   "PA Unpacker",
  labels:        "Label Batches",
  templates:     "Label Templates",
  cartons:       "Carton Labels",
  receiving:     "Receiving",
  exceptions:    "Exceptions",
  edi_workflow:  "Workflow Guide",
  notifications: "Notifications",
};

function readPlmUser(): { id?: string; name?: string; display_name?: string; email?: string } | null {
  try {
    const u = sessionStorage.getItem("plm_user");
    return u ? (JSON.parse(u) as { id?: string; name?: string; display_name?: string; email?: string }) : null;
  } catch { return null; }
}

export default function GS1App() {
  const activeTab       = useGS1Store(s => s.activeTab);
  const setActiveTabRaw = useGS1Store(s => s.setActiveTab);
  // NavDrawer fires menu-click telemetry itself (logClick via the gs1/* menu_key
  // resolved from moduleParam="tab"), so onSelectModule just swaps the tab.
  const setActiveTab = (tab: GS1Tab) => setActiveTabRaw(tab);

  // Drawer collapse — local + localStorage, mirroring the Tangerine shell.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("gs1:nav:collapsed:v1") === "1"; } catch { return false; }
  });
  const toggleDrawer = () => setCollapsed(v => {
    const next = !v;
    try { localStorage.setItem("gs1:nav:collapsed:v1", next ? "1" : "0"); } catch {}
    return next;
  });

  const plm       = readPlmUser();
  const userId    = plm?.id ?? null;
  const userName  = plm?.name ?? plm?.display_name ?? null;
  const userEmail = plm?.email ?? null;
  const onSignOut = () => {
    try { sessionStorage.removeItem("plm_user"); } catch {}
    window.location.href = "/";
  };

  // Reflect the active tab in the browser tab.
  useDocumentTitle(`${GS1_TAB_LABELS[activeTab] ?? "GS1"} · GS1`);

  const unread = useAppUnreadCount({
    supabase: supabaseClient,
    userId,
    recipientColumn: "recipient_internal_id",
    app: "gs1",
  });

  const offset = collapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN;

  return (
    <div style={{ minHeight: "100vh", background: TH.surfaceHi, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <NavDrawer
        appKey="gs1"
        appLabel="GS1"
        logoText="G"
        moduleParam="tab"
        modules={GS1_MODULES}
        sections={GS1_SECTIONS}
        activeModule={activeTab}
        onSelectModule={(k) => { if (k) setActiveTab(k as GS1Tab); }}
        userEmail={userEmail}
        userName={userName}
        onSignOut={onSignOut}
        collapsed={collapsed}
        onToggleCollapsed={toggleDrawer}
        headerSlot={
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <a
              href="/"
              title="Back to PLM launcher"
              style={{ color: "#94a3b8", textDecoration: "none", fontSize: 12, padding: "2px 4px" }}
            >← PLM</a>
            <button
              onClick={() => setActiveTab("notifications")}
              title="Notifications"
              style={{
                width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                background: activeTab === "notifications" ? "rgba(59,130,246,0.16)" : "transparent",
                color: activeTab === "notifications" ? "#fff" : "#94a3b8",
                border: "none", borderRadius: 5, padding: "6px 4px", fontSize: 13, cursor: "pointer",
              }}
            >
              <span>Notifications</span>
              {unread > 0 && (
                <span style={{
                  minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
                  background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                }}>{unread > 9 ? "9+" : unread}</span>
              )}
            </button>
          </div>
        }
      />

      <main style={{
        marginLeft: offset,
        transition: "margin-left 0.2s ease",
        minHeight: "100vh",
        boxSizing: "border-box",
      }}>
        {activeTab === "company"  && <CompanySetupPanel />}
        {activeTab === "upc"      && <UpcMasterPanel />}
        {activeTab === "scale"    && <ScaleMasterPanel />}
        {activeTab === "gtins"    && <PackGtinMasterPanel />}
        {activeTab === "catalog"  && <CatalogPanel />}
        {activeTab === "upload"   && <PackingListUploadPanel />}
        {activeTab === "pa_unpacker" && <PAUnpackerPanel />}
        {activeTab === "labels"   && <LabelBatchPanel />}
        {activeTab === "templates" && <LabelTemplatesPanel />}
        {activeTab === "cartons"  && <CartonPanel />}
        {activeTab === "receiving"   && <ReceivingPanel />}
        {activeTab === "exceptions"  && <ExceptionsPanel />}
        {activeTab === "edi_workflow" && <EdiWorkflowPanel />}
        {activeTab === "notifications" && supabaseClient && userId && (
          <div style={{ padding: 24, background: "#0F172A", minHeight: "100%" }}>
            <NotificationsPage
              embed
              kind="internal"
              supabase={supabaseClient}
              userId={userId}
              title="Notifications"
              appFilter="gs1"
            />
          </div>
        )}
      </main>

      {supabaseClient && userId && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={userId}
          notificationsUrl="/notifications?from=gs1"
          currentPath={typeof window !== "undefined" ? window.location.pathname : undefined}
          isViewingNotifications={activeTab === "notifications"}
          sessionKey="rof_notif_dismissed_internal"
          autoOpen={false}
          appFilter="gs1"
        />
      )}
      {/* Cross-cutter T6-3 — ⌘K / Ctrl-K global search palette. */}
      <GlobalSearchPaletteAuto />
      {/* Tangerine P10-5 — Top-bar entity switcher (fixed top-right). */}
      <EntitySwitcher />
    </div>
  );
}
