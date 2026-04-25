import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "./components/ErrorBoundary";
import WithNotifications from "./components/notifications/WithNotifications";
import { appConfig } from "./config/env";
import { canAccessInventoryPlanning, getPlmSessionEmail } from "./config/planningAccess";

// Simple path-based routing — no router library needed
const path = window.location.pathname;

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
      <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
      <h1 style={{ margin: 0, fontSize: 20, color: "#111827" }}>Inventory Planning</h1>
      <p style={{ margin: "10px 0 24px", maxWidth: 360 }}>{reason}</p>
      <a href="/" style={{ color: "#CC2200", fontSize: 14, textDecoration: "none" }}>
        ← Back to launcher
      </a>
    </div>
  );
}

async function mount() {
  // ── Staging banner ────────────────────────────────────────────────────────
  // Mounted in its own div so it's independent of whichever sub-app loads.
  if (appConfig.isStaging) {
    const { default: StagingBanner } = await import("./components/StagingBanner");
    const bannerDiv = document.createElement("div");
    bannerDiv.id = "staging-banner-root";
    document.body.prepend(bannerDiv);
    // Push the main root down so the banner doesn't overlap app headers.
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

  } else if (path.startsWith("/design")) {
    const { default: App } = await import("./App");
    root.render(<StrictMode><ErrorBoundary appName="Design Calendar"><App /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/tanda")) {
    const { default: TandA } = await import("./TandA");
    root.render(<StrictMode><ErrorBoundary appName="PO WIP"><TandA /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/techpack")) {
    const { default: TechPack } = await import("./TechPack");
    root.render(<StrictMode><ErrorBoundary appName="Tech Packs"><TechPack /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/ats")) {
    const { default: ATS } = await import("./ATS");
    root.render(<StrictMode><ErrorBoundary appName="ATS"><ATS /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/gs1")) {
    const { default: GS1 } = await import("./GS1");
    root.render(<StrictMode><ErrorBoundary appName="GS1 Labels"><GS1 /></ErrorBoundary></StrictMode>);

  } else if (path.startsWith("/planning")) {
    // ── Planning gate ─────────────────────────────────────────────────────
    // All /planning/* sub-routes share the same access check so it only
    // needs to live in one place.
    if (!planningAccessAllowed()) {
      root.render(<StrictMode><ErrorBoundary appName="Planning"><PlanningBlocked /></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/data-quality")) {
      const { default: DataQualityReport } = await import("./inventory-planning/admin/DataQualityReport");
      root.render(<StrictMode><ErrorBoundary appName="Planning DQ"><WithNotifications><DataQualityReport /></WithNotifications></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/ecom")) {
      const { default: EcomPlanningWorkbench } = await import("./inventory-planning/ecom/panels/EcomPlanningWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Ecom Planning"><WithNotifications><EcomPlanningWorkbench /></WithNotifications></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/supply")) {
      const { default: ReconciliationWorkbench } = await import("./inventory-planning/supply/panels/ReconciliationWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Supply Reconciliation"><WithNotifications><ReconciliationWorkbench /></WithNotifications></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/accuracy")) {
      const { default: AccuracyWorkbench } = await import("./inventory-planning/accuracy/panels/AccuracyWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Accuracy & AI"><WithNotifications><AccuracyWorkbench /></WithNotifications></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/scenarios")) {
      const { default: ScenarioManager } = await import("./inventory-planning/scenarios/panels/ScenarioManager");
      root.render(<StrictMode><ErrorBoundary appName="Scenarios & Exports"><WithNotifications><ScenarioManager /></WithNotifications></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/execution")) {
      const { default: ExecutionBatchManager } = await import("./inventory-planning/execution/panels/ExecutionBatchManager");
      root.render(<StrictMode><ErrorBoundary appName="Execution"><WithNotifications><ExecutionBatchManager /></WithNotifications></ErrorBoundary></StrictMode>);

    } else if (path.startsWith("/planning/admin")) {
      const { default: AdminWorkbench } = await import("./inventory-planning/admin/panels/AdminWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Admin"><WithNotifications><AdminWorkbench /></WithNotifications></ErrorBoundary></StrictMode>);

    } else {
      // /planning or /planning/wholesale
      const { default: WholesalePlanningWorkbench } = await import("./inventory-planning/panels/WholesalePlanningWorkbench");
      root.render(<StrictMode><ErrorBoundary appName="Wholesale Planning"><WithNotifications><WholesalePlanningWorkbench /></WithNotifications></ErrorBoundary></StrictMode>);
    }

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
  } else {
    // Root "/" — PLM Launcher
    const { default: PLMApp } = await import("./PLM");
    root.render(<StrictMode><ErrorBoundary appName="PLM"><PLMApp /></ErrorBoundary></StrictMode>);
  }
}

mount();
