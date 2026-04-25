import React from "react";
import { TH } from "../utils/theme";
import { useGS1Store } from "./store/gs1Store";
import GS1NavBar from "./panels/NavBar";
import CompanySetupPanel from "./panels/CompanySetupPanel";
import UpcMasterPanel from "./panels/UpcMasterPanel";
import ScaleMasterPanel from "./panels/ScaleMasterPanel";
import PackGtinMasterPanel from "./panels/PackGtinMasterPanel";
import PackingListUploadPanel from "./panels/PackingListUploadPanel";
import LabelBatchPanel from "./panels/LabelBatchPanel";
import CartonPanel from "./panels/CartonPanel";
import ReceivingPanel from "./panels/ReceivingPanel";
import LabelTemplatesPanel from "./panels/LabelTemplatesPanel";
import ExceptionsPanel from "./panels/ExceptionsPanel";
import NotificationsPage from "../components/notifications/NotificationsPage";
import NotificationsShell from "../components/notifications/NotificationsShell";
import { supabaseClient } from "../utils/supabase";

function readPlmUserId(): string | null {
  try {
    const u = sessionStorage.getItem("plm_user");
    return u ? (JSON.parse(u) as { id?: string }).id || null : null;
  } catch { return null; }
}

export default function GS1App() {
  const activeTab = useGS1Store(s => s.activeTab);
  const userId = readPlmUserId();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: TH.surfaceHi, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <GS1NavBar />
      <div style={{ flex: 1, overflowY: "auto" }}>
        {activeTab === "company"  && <CompanySetupPanel />}
        {activeTab === "upc"      && <UpcMasterPanel />}
        {activeTab === "scale"    && <ScaleMasterPanel />}
        {activeTab === "gtins"    && <PackGtinMasterPanel />}
        {activeTab === "upload"   && <PackingListUploadPanel />}
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
      </div>
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
    </div>
  );
}
