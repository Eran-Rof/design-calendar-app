// Parent admin page at /planning/admin. Tabs:
//   Roles · Integrations · Jobs · Audit
// Header shows the current impersonated user (Phase 7 dev-time switcher).

import { useEffect, useState } from "react";
import type { IpUserWithPermissions } from "../../governance/types/governance";
import { currentUserEmail, loadPermissionsFor } from "../../governance/services/permissionService";
import { S, PAL } from "../../components/styles";
import Toast, { type ToastMessage } from "../../components/Toast";
import UserSwitcher from "../components/UserSwitcher";
import RolesPermissionsPanel from "./RolesPermissionsPanel";
import IntegrationHealthDashboard from "./IntegrationHealthDashboard";
import JobRunsDashboard from "./JobRunsDashboard";
import AuditExplorer from "./AuditExplorer";
import RunsAdminPanel from "./RunsAdminPanel";

type TabKey = "roles" | "runs" | "integrations" | "jobs" | "audit";

export default function AdminWorkbench() {
  const [user, setUser] = useState<IpUserWithPermissions | null>(null);
  const [tab, setTab] = useState<TabKey>("roles");
  const [toast, setToast] = useState<ToastMessage | null>(null);

  useEffect(() => {
    void loadPermissionsFor(currentUserEmail()).then(setUser);
  }, []);

  return (
    <div style={S.app}>
      <div style={S.content}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <UserSwitcher onChange={setUser} />
        </div>
        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabBtn active={tab === "roles"} onClick={() => setTab("roles")}>Roles & permissions</TabBtn>
          <TabBtn active={tab === "runs"} onClick={() => setTab("runs")}>Runs</TabBtn>
          <TabBtn active={tab === "integrations"} onClick={() => setTab("integrations")}>Integration health</TabBtn>
          <TabBtn active={tab === "jobs"} onClick={() => setTab("jobs")}>Job runs</TabBtn>
          <TabBtn active={tab === "audit"} onClick={() => setTab("audit")}>Audit explorer</TabBtn>
        </div>

        {tab === "roles" && user && (
          <RolesPermissionsPanel currentUser={user} onToast={setToast} />
        )}
        {tab === "runs" && (
          <RunsAdminPanel onToast={setToast} />
        )}
        {tab === "integrations" && (
          <IntegrationHealthDashboard />
        )}
        {tab === "jobs" && user && (
          <JobRunsDashboard onToast={setToast} currentUserEmail={user.user_email} />
        )}
        {tab === "audit" && (
          <AuditExplorer />
        )}
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
            style={{
              background: active ? PAL.panel : "transparent",
              border: `1px solid ${active ? PAL.accent : PAL.border}`,
              color: active ? PAL.text : PAL.textDim,
              borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>{children}</button>
  );
}
