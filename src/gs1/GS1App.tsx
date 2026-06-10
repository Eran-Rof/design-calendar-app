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
  upload:        "Packing List",
  pa_unpacker:   "PA Unpacker",
  labels:        "Label Batches",
  templates:     "Label Templates",
  cartons:       "Carton Labels",
  receiving:     "Receiving",
  exceptions:    "Exceptions",
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
      />

      {/* Slim top bar — anchored to the right of the drawer; holds the
          notifications bell + entity switcher (mirrors the Tangerine shell). */}
      <div style={{
        position: "fixed", top: 0, right: 0, left: offset,
        height: 40, zIndex: 150,
        display: "flex", alignItems: "center", justifyContent: "flex-end",
        gap: 8, padding: "0 16px",
        background: TH.header, color: "#fff",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        transition: "left 0.2s ease",
      }}>
        <button
          onClick={() => setActiveTab("notifications")}
          title="Notifications"
          style={{
            background: activeTab === "notifications" ? TH.primary : "transparent",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 6, padding: "4px 10px", fontSize: 13,
            cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
          }}
        >
          🔔 Notifications
          {unread > 0 && (
            <span style={{
              minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
              background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}>{unread > 9 ? "9+" : unread}</span>
          )}
        </button>
        <EntitySwitcher inline />
      </div>

      <main style={{
        marginLeft: offset,
        transition: "margin-left 0.2s ease",
        paddingTop: 40,
        minHeight: "100vh",
        boxSizing: "border-box",
      }}>
        {activeTab === "company"  && <CompanySetupPanel />}
        {activeTab === "upc"      && <UpcMasterPanel />}
        {activeTab === "scale"    && <ScaleMasterPanel />}
        {activeTab === "gtins"    && <PackGtinMasterPanel />}
        {activeTab === "upload"   && <PackingListUploadPanel />}
        {activeTab === "pa_unpacker" && <PAUnpackerPanel />}
        {activeTab === "labels"   && <LabelBatchPanel />}
        {activeTab === "templates" && <LabelTemplatesPanel />}
        {activeTab === "cartons"  && <CartonPanel />}
        {activeTab === "receiving"   && <ReceivingPanel />}
        {activeTab === "exceptions"  && <ExceptionsPanel />}
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
    </div>
  );
}
