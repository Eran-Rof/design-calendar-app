import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "./components/ErrorBoundary";

// Simple path-based routing — no router library needed
const path = window.location.pathname;

async function mount() {
  const root = createRoot(document.getElementById("root")!);

  if (path.startsWith("/vendor")) {
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
    root.render(<StrictMode><ErrorBoundary appName="Planning DQ"><DataQualityReport /></ErrorBoundary></StrictMode>);
  } else if (path.startsWith("/planning/ecom")) {
    const { default: EcomPlanningWorkbench } = await import("./inventory-planning/ecom/panels/EcomPlanningWorkbench");
    root.render(<StrictMode><ErrorBoundary appName="Ecom Planning"><EcomPlanningWorkbench /></ErrorBoundary></StrictMode>);
  } else if (path.startsWith("/planning/wholesale") || path.startsWith("/planning")) {
    const { default: WholesalePlanningWorkbench } = await import("./inventory-planning/panels/WholesalePlanningWorkbench");
    root.render(<StrictMode><ErrorBoundary appName="Wholesale Planning"><WholesalePlanningWorkbench /></ErrorBoundary></StrictMode>);
  } else {
    // Root "/" — PLM Launcher
    const { default: PLMApp } = await import("./PLM");
    root.render(<StrictMode><ErrorBoundary appName="PLM"><PLMApp /></ErrorBoundary></StrictMode>);
  }
}

mount();
