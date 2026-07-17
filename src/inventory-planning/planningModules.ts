// Inventory Planning nav module registry for the shared <NavDrawer>.
//
// Planning navigates by REAL ROUTES (full page loads) — each module `key` is the
// /planning/<slug> route slug dispatched in src/main.tsx, NOT an in-page view id.
// The slugs are the superset of erp/modules.ts PLANNING_SCREENS plus the extra
// operational routes (reconcile / admin / reports / data-quality) that main.tsx
// also serves. Sections group them into the operator's forecast → supply →
// execution → reports → setup flow.
import type { NavModule, NavSection } from "../tanda/NavDrawer";

export const PLANNING_MODULES: NavModule[] = [
  // Demand forecasting.
  { key: "wholesale",    label: "Wholesale",     emoji: "🛒", group: "Forecast" },
  { key: "ecom",         label: "Ecom",          emoji: "🛍️", group: "Forecast" },
  // Supply reconciliation + buy recs.
  { key: "supply",       label: "Supply",        emoji: "⚖️", group: "Supply" },
  { key: "reconcile",    label: "Build Reconcile", emoji: "🧮", group: "Supply" },
  // What-if + execution.
  { key: "scenarios",    label: "Scenarios",     emoji: "🔀", group: "Planning" },
  { key: "execution",    label: "Execution",     emoji: "🚀", group: "Planning" },
  // Accuracy + reporting.
  { key: "accuracy",     label: "Accuracy & AI", emoji: "🎯", group: "Reports" },
  { key: "reports",      label: "Reports",       emoji: "📊", group: "Reports" },
  { key: "data-quality", label: "Data Quality",  emoji: "🔍", group: "Reports" },
  // Setup.
  { key: "vendors",      label: "Vendors",       emoji: "🏭", group: "Setup" },
  { key: "admin",        label: "Admin",         emoji: "⚙️", group: "Setup" },
];

export const PLANNING_SECTIONS: NavSection[] = [
  { section: "Forecast", emoji: "📈", groups: ["Forecast"] },
  { section: "Supply",   emoji: "⚖️", groups: ["Supply"] },
  { section: "Planning", emoji: "🔀", groups: ["Planning"] },
  { section: "Reports",  emoji: "📊", groups: ["Reports"] },
  { section: "Setup",    emoji: "⚙️", groups: ["Setup"] },
];

// Derive the active module key from the current /planning/<slug> path. Bare
// "/planning" (and "/planning/") land on the Wholesale workbench, matching the
// main.tsx dispatch default.
export function planningActiveModuleFromPath(pathname: string): string {
  const m = pathname.replace(/\/+$/, "").match(/^\/planning(?:\/([^/?#]+))?/);
  const slug = m?.[1];
  return slug || "wholesale";
}
