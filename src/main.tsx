import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "./components/ErrorBoundary";
import WithNotifications from "./components/notifications/WithNotifications";

// Simple path-based routing — no router library needed
const path = window.location.pathname;

async function mount() {
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
  } else if (path.startsWith("/planning/wholesale") || path.startsWith("/planning")) {
    const { default: WholesalePlanningWorkbench } = await import("./inventory-planning/panels/WholesalePlanningWorkbench");
    root.render(<StrictMode><ErrorBoundary appName="Wholesale Planning"><WithNotifications><WholesalePlanningWorkbench /></WithNotifications></ErrorBoundary></StrictMode>);
  } else {
    // Root "/" — PLM Launcher
    const { default: PLMApp } = await import("./PLM");
    root.render(<StrictMode><ErrorBoundary appName="PLM"><PLMApp /></ErrorBoundary></StrictMode>);
  }
}

mount();
