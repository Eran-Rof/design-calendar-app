// PlanningShell — thin chrome wrapper used by every /planning/* route.
//
// Adds the same notifications affordances every other internal app
// has: a Notifications header button with unread badge, a card-
// grouped in-app inbox filtered to planning-relevant events, and the
// background NotificationsShell for toast delivery. Wraps the panel
// passed in as children so individual workbenches stay focused on
// their own data and don't each need to wire notifications themselves.
//
// Navigation is the shared left <NavDrawer> (de-iconed, collapsible) — the
// same drawer GS1 / Costing / Design Calendar use. Because Planning navigates
// by REAL ROUTES (each /planning/<slug> is a full page load dispatched in
// main.tsx), selecting a module does window.location.href = '/planning/<key>'
// and the drawer's active highlight is derived from window.location.pathname.

import { useState, type ReactNode } from "react";
import NotificationsPage from "../../../components/notifications/NotificationsPage";
import NotificationsShell from "../../../components/notifications/NotificationsShell";
import { useAppUnreadCount } from "../../../components/notifications/useAppUnreadCount";
import { supabaseClient } from "../../../utils/supabase";
import { PAL } from "../../components/styles";
import { AskAIPanel } from "../../../ai/AskAIPanel";
import type { GridContextSnapshot } from "../../../ai/tools";
import { WarnHost } from "../../../shared/ui/warn";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { NavDrawer, DRAWER_W_OPEN, DRAWER_W_CLOSED } from "../../../tanda/NavDrawer";
import {
  PLANNING_MODULES,
  PLANNING_SECTIONS,
  planningActiveModuleFromPath,
} from "../../planningModules";

// PLM login user (sessionStorage) — id scopes the internal notifications bell;
// name/email feed the drawer's user footer (mirrors GS1App / CostingApp).
function readPlmUser(): { id?: string; name?: string; display_name?: string; email?: string } | null {
  try {
    const raw = sessionStorage.getItem("plm_user");
    return raw ? (JSON.parse(raw) as { id?: string; name?: string; display_name?: string; email?: string }) : null;
  } catch { return null; }
}

interface Props {
  /** Section label shown in the header (e.g. "Wholesale Planning"). */
  title: string;
  children: ReactNode;
}

export default function PlanningShell({ title, children }: Props) {
  const plm = readPlmUser();
  const userId = plm?.id ?? null;
  const userName = plm?.name ?? plm?.display_name ?? null;
  const userEmail = plm?.email ?? null;

  // Drawer collapse — local + localStorage, mirroring the GS1 / Costing / DC shells.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("planning:nav:collapsed:v1") === "1"; } catch { return false; }
  });
  const toggleDrawer = () => setCollapsed((v) => {
    const next = !v;
    try { localStorage.setItem("planning:nav:collapsed:v1", next ? "1" : "0"); } catch {}
    return next;
  });

  // Drawer highlight follows the current /planning/<slug> route. Navigation is a
  // full page load (the app's model) so there is no in-page view state to track.
  const activeModule = planningActiveModuleFromPath(
    typeof window !== "undefined" ? window.location.pathname : "/planning",
  );
  const offset = collapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN;

  const onSignOut = () => {
    try { sessionStorage.removeItem("plm_user"); } catch {}
    window.location.href = "/";
  };
  // Reflect the active planning section in the browser tab. Most section
  // titles already include "Planning" (e.g. "Wholesale Planning") — only
  // suffix " · Planning" when they don't, to avoid "Planning · Planning".
  useDocumentTitle(title.includes("Planning") ? title : `${title} · Planning`);
  const [showNotifs, setShowNotifs] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const unread = useAppUnreadCount({
    supabase: supabaseClient,
    userId,
    recipientColumn: "recipient_internal_id",
    app: "planning",
  });

  return (
    <div style={{ minHeight: "100vh", background: PAL.bg }}>
      <NavDrawer
        appKey="planning"
        appLabel="Inventory Planning"
        logoText="P"
        moduleParam="route"
        modules={PLANNING_MODULES}
        sections={PLANNING_SECTIONS}
        activeModule={activeModule}
        // Real-route navigation — each /planning/<slug> is a full page load
        // (the app's model; matches the existing <a href> links). The drawer's
        // logo-home click passes null → go to the Wholesale landing route.
        onSelectModule={(k) => { window.location.href = k ? `/planning/${k}` : "/planning/wholesale"; }}
        userEmail={userEmail}
        userName={userName}
        onSignOut={onSignOut}
        collapsed={collapsed}
        onToggleCollapsed={toggleDrawer}
      />

      <div style={{
        marginLeft: offset,
        transition: "margin-left 0.2s ease",
      }}>
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 18px",
        background: PAL.panel,
        borderBottom: `1px solid ${PAL.border}`,
        gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, color: PAL.text }}>
          {/* ← PLM moved into the shared NavDrawer footer (backToPlmHome). */}
          <span style={{ fontWeight: 700, fontSize: 14, color: PAL.text }}>{title}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => setAiOpen(true)}
            title="Ask Claude about forecasts, allocations, recommendations — anything ROF"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid #5B21B6",
              background: "#7C3AED",
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
            }}
          >
            Ask AI
          </button>
          <button
            onClick={() => setShowNotifs((v) => !v)}
            title="Notifications"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: 6,
              border: `1px solid ${PAL.border}`,
              background: showNotifs ? `${PAL.accent}15` : "transparent",
              color: showNotifs ? PAL.accent : PAL.textDim,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: showNotifs ? 600 : 500,
              fontFamily: "inherit",
            }}
          >
            Notifications
            {unread > 0 && (
              <span style={{
                minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
                background: PAL.red, color: "#fff", fontSize: 10, fontWeight: 700,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}>{unread > 9 ? "9+" : unread}</span>
            )}
          </button>
        </div>
      </header>

      {showNotifs && supabaseClient && userId ? (
        <div style={{ padding: 24 }}>
          <NotificationsPage
            embed
            kind="internal"
            supabase={supabaseClient}
            userId={userId}
            title="Notifications"
            appFilter="planning"
          />
        </div>
      ) : (
        children
      )}
      </div>

      {supabaseClient && userId && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={userId}
          notificationsUrl="/notifications?from=planning"
          currentPath={typeof window !== "undefined" ? window.location.pathname : undefined}
          isViewingNotifications={showNotifs}
          sessionKey="rof_notif_dismissed_internal"
          autoOpen={false}
          appFilter="planning"
        />
      )}

      <AskAIPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        buildContext={(): GridContextSnapshot => ({
          columns: ["sku", "channel", "customer", "period", "forecast", "shortage", "excess"],
          active_filters: { search: title },
          sort: null,
          row_count: 0,
          distinct: {
            categories: [],
            sub_categories: [],
            styles: [],
            genders: [],
            stores: [],
          },
        })}
        setters={{}}
        samplePrompts={[
          "Which SKUs are projected to stock out next month?",
          "Forecast accuracy MAPE by method last quarter",
          "Open buy recommendations grouped by priority",
          "Top 10 SKUs by shortage qty this period",
          "How many execution batches are pending approval?",
          "Average lead time by vendor for active SKUs",
        ]}
        appId="planning"
      />

      {/* Canonical app-colored toast + confirm surface (shared with Tangerine /
          ATS / TandA). Lets planning panels call confirmDialog()/notify()
          instead of raw browser alert()/confirm(), so warnings match all apps. */}
      <WarnHost />
    </div>
  );
}
