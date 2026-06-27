import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "./components/ErrorBoundary";
import WithNotifications from "./components/notifications/WithNotifications";
import PlanningShell from "./inventory-planning/shared/components/PlanningShell";
import { appConfig } from "./config/env";
import { canAccessInventoryPlanning, getPlmSessionEmail } from "./config/planningAccess";
import { canAccessAppFromSession } from "./permissions";
import { installInternalApiAuth } from "./utils/internalApiAuth";
import { installIdleLogout } from "./utils/installIdleLogout";

// Inject Authorization: Bearer header on every /api/internal/* fetch
// from the browser. Reads VITE_INTERNAL_API_TOKEN at build time.
// Idempotent — safe to call once at boot.
installInternalApiAuth();

// Simple path-based routing — no router library needed
const path = window.location.pathname;

// 1-hour idle auto-logout for every internal sub-app. Skips:
//   /vendor  — Supabase Auth, separate session lifecycle.
//   /design  — App.tsx mounts its own useIdleLogout with a 5-min warning banner.
//   /b2b     — external customer portal, Supabase Auth, separate session lifecycle.
if (!path.startsWith("/vendor") && !path.startsWith("/design") && !path.startsWith("/b2b")) {
  installIdleLogout();
}

// ── Planning access gate ───────────────────────────────────────────────────────
// Evaluated once at mount. Beta-only mode reads the PLM session from
// sessionStorage (written by PLM.tsx after login).
function planningAccessAllowed(): boolean {
  return canAccessInventoryPlanning(getPlmSessionEmail());
}

// Shown when planning is disabled or the user is not in the beta allowlist.
function PlanningBlocked() {
  const reason = !appConfig.inventoryPlanningEnabled
    ? "Inventory Planning is not enabled in this environment."
    : "Your account is not on the Inventory Planning beta access list.";

  return (
    <div
      style={{
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        justifyContent: "center",
        height:         "100vh",
        fontFamily:     "system-ui, -apple-system, sans-serif",
        color:          "#6B7280",
        textAlign:      "center",
        padding:        "0 24px",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20, color: "#111827" }}>Inventory Planning</h1>
      <p style={{ margin: "10px 0 24px", maxWidth: 360 }}>{reason}</p>
      <a href="/" style={{ color: "#CC2200", fontSize: 14, textDecoration: "none" }}>
        ← Back to launcher
      </a>
    </div>
  );
}

// Shown when a user without permissions.<app>.access navigates directly to an
// app route. The launcher card is already locked for them in PLM.tsx, but the
// route itself must refuse too — the card lock is UX, not a security boundary.
function AppAccessBlocked({ appName }: { appName: string }) {
  return (
    <div
      style={{
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        justifyContent: "center",
        height:         "100vh",
        fontFamily:     "system-ui, -apple-system, sans-serif",
        color:          "#6B7280",
        textAlign:      "center",
        padding:        "0 24px",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20, color: "#111827" }}>{appName}</h1>
      <p style={{ margin: "10px 0 24px", maxWidth: 360 }}>
        Your account does not have access to {appName}.
      </p>
      <a href="/" style={{ color: "#CC2200", fontSize: 14, textDecoration: "none" }}>
        ← Back to launcher
      </a>
    </div>
  );
}

async function mount() {
  // ── Demo / staging banner ─────────────────────────────────────────────────
  // Mounted in its own div so it's independent of whichever sub-app loads.
  // Demo takes precedence over staging when both flags are set.
  if (appConfig.demoMode) {
    const { default: DemoBanner } = await import("./components/DemoBanner");
    const bannerDiv = document.createElement("div");
    bannerDiv.id = "demo-banner-root";
    document.body.prepend(bannerDiv);
    const rootEl = document.getElementById("root");
    if (rootEl) rootEl.style.paddingTop = "34px";
    createRoot(bannerDiv).render(<StrictMode><DemoBanner /></StrictMode>);
  } else if (appConfig.isStaging) {
    const { default: StagingBanner } = await import("./components/StagingBanner");
    const bannerDiv = document.createElement("div");
    bannerDiv.id = "staging-banner-root";
    document.body.prepend(bannerDiv);
    const rootEl = document.getElementById("root");
    if (rootEl) rootEl.style.paddingTop = "34px";
    createRoot(bannerDiv).render(<StrictMode><StagingBanner /></StrictMode>);
  }

  const root = createRoot(document.getElementById("root")!);

  if (path.startsWith("/rof/phase-reviews")) {
    const { default: PhaseReviews } = await import("./rof/PhaseReviews");
    root.render(<StrictMode><ErrorBoundary appName="Phase Reviews"><WithNotifications><PhaseReviews /></WithNotifications></ErrorBoundary></StrictMode>);
  } else if (path.startsWith("/vendor")) {
    // External vendor portal — Supabase Auth, isolated from internal apps.
    // Sub-routing (/vendor/login, /vendor/setup, /vendor) lives inside VendorApp via react-router-dom.
    const { default: VendorApp } = await import("./vendor/VendorApp");
    root.render(<StrictMode><ErrorBoundary appName="Vendor Portal"><VendorApp /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/b2b")) {
    // External B2B customer portal — passwordless Supabase Auth, isolated from
    // internal staff and the vendor portal (separate browser client + storageKey).
    const { default: B2BApp } = await import("./b2b/B2BApp");
    root.render(<StrictMode><ErrorBoundary appName="B2B Portal"><B2BApp /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/login")) {
    // Standalone Tangerine-branded front door (Microsoft-365 sign-in). Always
    // reachable; becomes the root "/" once VITE_TANGERINE_AS_HOME is flipped on.
    const { default: TangerineLogin } = await import("./TangerineLogin");
    root.render(<StrictMode><ErrorBoundary appName="Sign in"><TangerineLogin /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/design")) {
    if (!canAccessAppFromSession("design")) {
      root.render(<StrictMode><ErrorBoundary appName="Design Calendar"><AppAccessBlocked appName="Design Calendar" /></ErrorBoundary></StrictMode>);
    } else {
      const { default: App } = await import("./App");
      root.render(<StrictMode><ErrorBoundary appName="Design Calendar"><App /></ErrorBoundary></StrictMode>);
    }

  } else if (path.startsWith("/tangerine")) {
    // Gate by the PLM per-user permission when a plm_user session exists.
    // Default-true semantics (canAccessAppFromSession returns true with no
    // session) means a direct Microsoft-OAuth entrant — who has no plm_user
    // blob — still reaches Tangerine's own MS sign-in gate untouched; only a
    // PLM-session user explicitly set to tangerine.access=false is blocked.
    if (!canAccessAppFromSession("tangerine")) {
      root.render(<StrictMode><ErrorBoundary appName="Tangerine"><AppAccessBlocked appName="Tangerine ERP" /></ErrorBoundary></StrictMode>);
    } else {
      const { default: Tangerine } = await import("./Tangerine");
      root.render(<StrictMode><ErrorBoundary appName="Tangerine"><Tangerine /></ErrorBoundary></StrictMode>);
    }

  } else if (path.startsWith("/tanda")) {
    if (!canAccessAppFromSession("tanda")) {
      root.render(<StrictMode><ErrorBoundary appName="PO WIP"><AppAccessBlocked appName="PO WIP" /></ErrorBoundary></StrictMode>);
    } else {
      const { default: TandA } = await import("./TandA");
      root.render(<StrictMode><ErrorBoundary appName="PO WIP"><TandA /></ErrorBoundary></StrictMode>);
    }

  } else if (path.startsWith("/techpack")) {
    if (!canAccessAppFromSession("techpack")) {
      root.render(<StrictMode><ErrorBoundary appName="Tech Packs"><AppAccessBlocked appName="Tech Packs" /></ErrorBoundary></StrictMode>);
    } else {
      const { default: TechPack } = await import("./TechPack");
      root.render(<StrictMode><ErrorBoundary appName="Tech Packs"><TechPack /></ErrorBoundary></StrictMode>);
    }

  } else if (path.startsWith("/ats")) {
    if (!canAccessAppFromSession("ats")) {
      root.render(<StrictMode><ErrorBoundary appName="ATS"><AppAccessBlocked appName="ATS" /></ErrorBoundary></StrictMode>);
    } else {
      const { default: ATS } = await import("./ATS");
      root.render(<StrictMode><ErrorBoundary appName="ATS"><ATS /></ErrorBoundary></StrictMode>);
    }

  } else if (path.startsWith("/gs1")) {
    if (!canAccessAppFromSession("gs1")) {
      root.render(<StrictMode><ErrorBoundary appName="GS1 Labels"><AppAccessBlocked appName="GTIN Creation" /></ErrorBoundary></StrictMode>);
    } else {
      const { default: GS1 } = await import("./GS1");
      root.render(<StrictMode><ErrorBoundary appName="GS1 Labels"><GS1 /></ErrorBoundary></StrictMode>);
    }

  } else if (path.startsWith("/costing")) {
    if (!canAccessAppFromSession("costing")) {
      root.render(<StrictMode><ErrorBoundary appName="Costing"><AppAccessBlocked appName="Costing" /></ErrorBoundary></StrictMode>);
    } else {
      const { default: Costing } = await import("./Costing");
      root.render(<StrictMode><ErrorBoundary appName="Costing"><Costing /></ErrorBoundary></StrictMode>);
    }

  } else if (path.startsWith("/planning")) {
    // ── Planning gate ─────────────────────────────────────────────────────
    // Per-user permission first, then the beta email-allowlist. All
    // /planning/* sub-routes share the same checks so they live in one place.
    if (!canAccessAppFromSession("planning")) {
      root.render(<StrictMode><ErrorBoundary appName="Planning"><AppAccessBlocked appName="Inventory Planning" /></ErrorBoundary></StrictMode>);

    } else if (!planningAccessAllowed()) {
      root.render(<StrictMode><ErrorBoundary appName="Planning"><PlanningBlocked /></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/data-quality")) {
      const { default: DataQualityReport } = await import("./inventory-planning/admin/DataQualityReport");
      root.render(<StrictMode><ErrorBoundary appName="Planning DQ"><PlanningShell title="Data Quality"><DataQualityReport /></PlanningShell></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/ecom")) {
      const { default: EcomPlanningWorkbench } = await import("./inventory-planning/ecom/panels/EcomPlanningWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Ecom Planning"><PlanningShell title="Ecom Planning"><EcomPlanningWorkbench /></PlanningShell></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/supply")) {
      const { default: ReconciliationWorkbench } = await import("./inventory-planning/supply/panels/ReconciliationWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Supply Reconciliation"><PlanningShell title="Supply Reconciliation"><ReconciliationWorkbench /></PlanningShell></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/accuracy")) {
      const { default: AccuracyWorkbench } = await import("./inventory-planning/accuracy/panels/AccuracyWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Accuracy & AI"><PlanningShell title="Accuracy & AI"><AccuracyWorkbench /></PlanningShell></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/scenarios")) {
      const { default: ScenarioManager } = await import("./inventory-planning/scenarios/panels/ScenarioManager");
      root.render(<StrictMode><ErrorBoundary appName="Scenarios & Exports"><PlanningShell title="Scenarios & Exports"><ScenarioManager /></PlanningShell></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/reconcile")) {
      const { default: BuildReconcileWorkbench } = await import("./inventory-planning/panels/BuildReconcileWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Build Reconcile"><PlanningShell title="Build Reconcile"><BuildReconcileWorkbench /></PlanningShell></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/execution")) {
      const { default: ExecutionBatchManager } = await import("./inventory-planning/execution/panels/ExecutionBatchManager");
      root.render(<StrictMode><ErrorBoundary appName="Execution"><PlanningShell title="Execution"><ExecutionBatchManager /></PlanningShell></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/admin")) {
      const { default: AdminWorkbench } = await import("./inventory-planning/admin/panels/AdminWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Admin"><PlanningShell title="Planning Admin"><AdminWorkbench /></PlanningShell></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/reports")) {
      const { default: ReportsWorkbench } = await import("./inventory-planning/reports/panels/ReportsWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Planning Reports"><PlanningShell title="Planning Reports"><ReportsWorkbench /></PlanningShell></ErrorBoundary></StrictMode>);

    } else {
      // /planning or /planning/wholesale
      const { default: WholesalePlanningWorkbench } = await import("./inventory-planning/panels/WholesalePlanningWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Wholesale Planning"><PlanningShell title="Wholesale Planning"><WholesalePlanningWorkbench /></PlanningShell></ErrorBoundary></StrictMode>);
    }

  } else if (path.startsWith("/ai-facts")) {
    // Tier 2H — operator-authored Ask AI facts admin.
    const { default: UserFactsAdmin } = await import("./ai/admin/UserFactsAdmin");
    root.render(<StrictMode><ErrorBoundary appName="Ask AI Facts"><UserFactsAdmin /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/ai-documents")) {
    // Tier 3J — saved Ask AI workflow documents.
    const { default: DocumentsApp } = await import("./ai/documents/DocumentsApp");
    root.render(<StrictMode><ErrorBoundary appName="Ask AI Documents"><DocumentsApp /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/ai-ops")) {
    // Operator observability dashboard for Ask AI (cost, errors,
    // cache hits, slow tools). Reads ip_ai_call_log + ip_ai_answer_cache.
    const { default: OpsApp } = await import("./ai/ops/OpsApp");
    root.render(<StrictMode><ErrorBoundary appName="Ask AI Ops"><OpsApp /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/notifications")) {
    const [{ default: NotificationsPage }, { supabaseClient }] = await Promise.all([
      import("./components/notifications/NotificationsPage"),
      import("./utils/supabase"),
    ]);
    const plm = (() => { try { return JSON.parse(sessionStorage.getItem("plm_user") || "null"); } catch { return null; } })();
    const from = new URLSearchParams(window.location.search).get("from") || "";
    const backByFrom: Record<string, { href: string; label: string }> = {
      tanda: { href: "/tanda", label: "Back to PO WIP" },
      design: { href: "/design", label: "Back to Design Calendar" },
      techpack: { href: "/techpack", label: "Back to Tech Packs" },
      ats: { href: "/ats", label: "Back to ATS" },
      planning: { href: "/planning", label: "Back to Planning" },
      rof: { href: "/rof/phase-reviews", label: "Back to Phase Reviews" },
    };
    const defaultBack = plm?.id
      ? { href: "/tanda", label: "Back to PO WIP" }
      : { href: "/", label: "Back to PLM" };
    const backLink = backByFrom[from] || defaultBack;
    root.render(
      <StrictMode>
        <ErrorBoundary appName="Notifications">
          {supabaseClient && plm?.id ? (
            <NotificationsPage
              kind="internal"
              supabase={supabaseClient}
              userId={plm.id}
              title="Notifications"
              backLink={backLink}
            />
          ) : (
            <div style={{ padding: 24, color: "#F1F5F9", background: "#0F172A", minHeight: "100vh" }}>
              Sign in first — <a href="/" style={{ color: "#60A5FA" }}>go to PLM launcher</a>.
            </div>
          )}
        </ErrorBoundary>
      </StrictMode>,
    );
  } else if (appConfig.tangerineAsHome) {
    // Go-live: Tangerine is the front door. Root "/" sends users to the
    // standalone Tangerine login (which no-ops straight through if they already
    // hold a valid MS token). The PLM launcher is retired in this mode.
    window.location.replace("/login");
  } else {
    // Root "/" — PLM Launcher (default until VITE_TANGERINE_AS_HOME is flipped).
    const { default: PLMApp } = await import("./PLM");
    root.render(<StrictMode><ErrorBoundary appName="PLM"><PLMApp /></ErrorBoundary></StrictMode>);
  }
}

mount();
