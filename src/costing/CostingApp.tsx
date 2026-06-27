// Costing Module — top-level shell.
//
// Sub-routing via query string (?view=list|edit&id=...) driven by helpers.ts
// — no react-router dependency added. Listens to the custom "costing:navigate"
// event + popstate so back/forward and our own navigate() helper both work.
//
// Navigation is the shared left <NavDrawer> (de-iconed, collapsible) — the same
// drawer GS1 / Design Calendar use. Selecting a module calls helpers.navigate()
// which updates ?view= and fires "costing:navigate"; the existing listener
// below re-reads getView() so `activeModule` tracks the URL.

import React, { useEffect, useState } from "react";
import { TH, setConfirmHandler } from "../utils/theme";
import { WarnHost, confirmDialog } from "../shared/ui/warn";
import { supabaseClient } from "../utils/supabase";
import NotificationsShell from "../components/notifications/NotificationsShell";
import { useAppUnreadCount } from "../components/notifications/useAppUnreadCount";
import { NavDrawer, DRAWER_W_OPEN, DRAWER_W_CLOSED } from "../tanda/NavDrawer";
import { COSTING_MODULES, COSTING_SECTIONS } from "./costingModules";
import ProjectListView from "./views/ProjectListView";
import ProjectEditView from "./views/ProjectEditView";
import SettingsView from "./views/SettingsView";
import RfqListView from "./views/RfqListView";
import RfqEditView from "./views/RfqEditView";
import RfqCompareView from "./views/RfqCompareView";
import RfqMessagesInbox from "./views/RfqMessagesInbox";
import { getView, navigate, type CostingViewName } from "./helpers";
import { useDocumentTitle } from "../shared/useDocumentTitle";
import { AskAIPanel } from "../ai/AskAIPanel";
import type { AIGridSetters, GridContextSnapshot } from "../ai/tools";

// Costing-flavoured starter questions for Ask AI. These all resolve through the
// assistant's existing analytics tools (query_margin / style_card /
// customer_card / query_shipments) — the costing operator just gets them within
// reach from the top bar.
const COSTING_SAMPLE_PROMPTS = [
  "Which styles had a gross margin under 18% in the last 3 months?",
  "Show me my top 10 styles by trailing-3-month sales",
  "Compare last-year vs trailing-3-month sales for RYB0412",
  "Which customers are buying less than they did last year?",
];
// Pure Q&A here — no grid to drive, so context is minimal and there are no
// setters to apply suggestions with.
const EMPTY_SETTERS: AIGridSetters = {};
function buildCostingContext(): GridContextSnapshot {
  return {
    columns: [],
    active_filters: {},
    row_count: 0,
    distinct: { categories: [], sub_categories: [], styles: [], genders: [], stores: [] },
  };
}

// Browser-tab labels for the Costing views.
const COSTING_VIEW_LABELS: Record<string, string> = {
  list:       "Projects",
  edit:       "Project",
  messages:   "Messages",
  settings:   "Masters",
  "rfq-list": "RFQs",
  "rfq-edit": "RFQ",
  "rfq-compare": "Compare RFQs",
};

// Detail views collapse under their parent list for the drawer's active
// highlight — there is no drawer row for "edit" / "rfq-edit".
const ACTIVE_MODULE: Record<string, string> = {
  edit:       "list",
  "rfq-edit": "rfq-list",
};

// PLM login user (sessionStorage) — id scopes the internal notifications bell;
// name/email feed the drawer's user footer (mirrors GS1App.readPlmUser).
function readPlmUser(): { id?: string; name?: string; display_name?: string; email?: string } | null {
  try {
    const raw = sessionStorage.getItem("plm_user");
    return raw ? (JSON.parse(raw) as { id?: string; name?: string; display_name?: string; email?: string }) : null;
  } catch { return null; }
}

export default function CostingApp() {
  const [view, setView] = useState(getView());
  const [aiOpen, setAiOpen] = useState(false);
  const plm = readPlmUser();
  const userId = plm?.id ?? null;
  const userName = plm?.name ?? plm?.display_name ?? null;
  const userEmail = plm?.email ?? null;
  // Reflect the active view in the browser tab.
  useDocumentTitle(`${COSTING_VIEW_LABELS[view] ?? "Costing"} · Costing`);

  // Drawer collapse — local + localStorage, mirroring the GS1 / DC shells.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("costing:nav:collapsed:v1") === "1"; } catch { return false; }
  });
  const toggleDrawer = () => setCollapsed(v => {
    const next = !v;
    try { localStorage.setItem("costing:nav:collapsed:v1", next ? "1" : "0"); } catch {}
    return next;
  });

  const onSignOut = () => {
    try { sessionStorage.removeItem("plm_user"); } catch {}
    window.location.href = "/";
  };

  // Unread badge for the slim top-bar notifications link (costing-scoped).
  const unread = useAppUnreadCount({
    supabase: supabaseClient,
    userId,
    recipientColumn: "recipient_internal_id",
    app: "costing",
  });

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

  // Drawer highlight follows the URL view, collapsing detail views to parents.
  const activeModule = ACTIVE_MODULE[view] ?? view;
  const offset = collapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN;

  return (
    <div style={{
      minHeight: "100vh",
      // Match the dark data views (#0F172A) so the area below a short panel
      // reads as the same surface, not the light TH.surfaceHi (was a white
      // band under the data window).
      background: "#0F172A", fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <NavDrawer
        appKey="costing"
        appLabel="Costing"
        logoText="$"
        moduleParam="view"
        modules={COSTING_MODULES}
        sections={COSTING_SECTIONS}
        activeModule={activeModule}
        onSelectModule={(k) => { if (k) navigate(k as CostingViewName); }}
        userEmail={userEmail}
        userName={userName}
        onSignOut={onSignOut}
        collapsed={collapsed}
        onToggleCollapsed={toggleDrawer}
      />

      {/* Slim top bar — anchored right of the drawer; holds the back-to-PLM
          link + notifications bell + vendor portal links (mirrors GS1 shell). */}
      <div style={{
        position: "fixed", top: 0, right: 0, left: offset,
        height: 40, zIndex: 150,
        display: "flex", alignItems: "center", gap: 8, padding: "0 16px",
        background: TH.header, color: "#fff",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        transition: "left 0.2s ease",
      }}>
        {/* ← PLM moved into the shared NavDrawer footer (backToPlmHome). */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => setAiOpen(true)}
            title="Ask AI about your sales, margins, styles and customers"
            style={{
              color: "#fff", background: "transparent", cursor: "pointer",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 6, padding: "4px 10px", fontSize: 13,
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            Ask AI
          </button>
          <a
            href="/notifications?from=costing"
            title="Notifications"
            style={{
              color: "#fff", textDecoration: "none",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 6, padding: "4px 10px", fontSize: 13,
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            Notifications
            {unread > 0 && (
              <span style={{
                minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
                background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}>{unread > 9 ? "9+" : unread}</span>
            )}
          </a>
          <a href="/vendor" target="_blank" rel="noopener noreferrer"
             title="Open the vendor portal in a new tab"
             style={topLink}>Vendor Portal ↗</a>
          <a href="/vendor/onboarding" target="_blank" rel="noopener noreferrer"
             title="Open vendor onboarding in a new tab"
             style={topLink}>Vendor Onboarding ↗</a>
        </div>
      </div>

      <main style={{
        marginLeft: offset,
        transition: "margin-left 0.2s ease",
        paddingTop: 40,
        minHeight: "100vh",
        boxSizing: "border-box",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {view === "list" && <ProjectListView />}
          {view === "edit" && <ProjectEditView />}
          {view === "settings" && <SettingsView />}
          {view === "rfq-list" && <RfqListView />}
          {view === "rfq-edit" && <RfqEditView />}
          {view === "rfq-compare" && <RfqCompareView />}
          {view === "messages" && <RfqMessagesInbox />}
        </div>
      </main>

      {/* Canonical Tangerine warn surface — renders the shared toast +
          confirm modal (same layout + app colors as ATS / PO-WIP). Mounted
          once here since the Costing app boots standalone (not under the
          Tangerine shell where the other <WarnHost/> lives). */}
      <WarnHost />

      {/* Ask AI slide-in panel — shared analytics assistant, opened from the
          top-bar "Ask AI" button. appId "tangerine" routes to Opus + the full
          sales/inventory schema (constants.MODEL_BY_APP). */}
      <AskAIPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        buildContext={buildCostingContext}
        setters={EMPTY_SETTERS}
        samplePrompts={COSTING_SAMPLE_PROMPTS}
        appId="tangerine"
      />

      {/* Internal notifications bell, scoped to the Costing app (RFQ lifecycle
          events). These are routed here instead of the PLM launcher. */}
      {supabaseClient && userId && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={userId}
          notificationsUrl="/notifications?from=costing"
          currentPath={typeof window !== "undefined" ? window.location.pathname : undefined}
          sessionKey="rof_notif_dismissed_internal"
          appFilter="costing"
          autoOpen={false}
        />
      )}
    </div>
  );
}

const topLink: React.CSSProperties = {
  color: "rgba(255,255,255,0.75)", textDecoration: "none",
  border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6,
  padding: "4px 10px", fontSize: 13, whiteSpace: "nowrap",
};
