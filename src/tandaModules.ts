// PO WIP (Tanda) nav module registry for the shared <NavDrawer>.
//
// Module `key` = the TandA `view` string (DashboardView/ListView/… switch in
// TandA.tsx). Groups/sections mirror the old custom top-nav grouping
// (Purchase Orders / Collaboration) + the vendor flyout's VENDOR_MENU_GROUPS
// (Vendors / Operations / Compliance / Sourcing / Finance / Analytics & Admin).
//
// IMPORTANT — appKey/moduleParam: PO WIP's favorites + menu-click telemetry
// rows live in src/lib/menuKeys.ts as { app: "powip", route: "/tanda?view=…" }.
// So the drawer must be mounted with appKey="powip" + moduleParam="view" for
// the keys here (== the ?view= value) to resolve to the existing powip/* keys.
//
// Notifications, Email, Timeline-search, Sync, Bulk Update and Settings are
// intentionally NOT here — Notifications + the per-item side-effect actions are
// dispatched by TandA.tsx; Sync/Bulk/Settings/Search stay as top-bar buttons.
import type { NavModule, NavSection } from "./tanda/NavDrawer";

export const TANDA_MODULES: NavModule[] = [
  // ── Purchase Orders (top-level views) ──
  { key: "dashboard",  label: "Dashboard",  emoji: "🏠", group: "Purchase Orders" },
  { key: "list",       label: "All POs",    emoji: "📋", group: "Purchase Orders" },
  { key: "grid",       label: "Grid",       emoji: "🗂", group: "Purchase Orders" },
  { key: "timeline",   label: "Timeline",   emoji: "📊", group: "Purchase Orders" },
  { key: "archive",    label: "Archive",    emoji: "📦", group: "Purchase Orders" },
  { key: "templates",  label: "Templates",  emoji: "📐", group: "Purchase Orders" },

  // ── Collaboration ──
  { key: "teams",      label: "Teams",      emoji: "💬", group: "Collaboration" },
  { key: "email",      label: "Email",      emoji: "📧", group: "Collaboration" },
  { key: "activity",   label: "Activity",   emoji: "📋", group: "Collaboration" },

  // ── Vendors ──
  { key: "vendors",            label: "Directory",      emoji: "🏢", group: "Vendors" },
  { key: "onboarding",         label: "Onboarding",     emoji: "🚀", group: "Vendors" },
  { key: "preferred_vendors",  label: "Preferred",      emoji: "⭐", group: "Vendors" },
  { key: "scorecards",         label: "Scorecards",     emoji: "🏆", group: "Vendors" },
  { key: "health_scores",      label: "Health Scores",  emoji: "❤️", group: "Vendors" },
  { key: "diversity",          label: "Diversity",      emoji: "🤝", group: "Vendors" },
  { key: "sustainability",     label: "Sustainability", emoji: "🌱", group: "Vendors" },
  { key: "esg_scores",         label: "ESG Scores",     emoji: "🌍", group: "Vendors" },

  // ── Operations ──
  { key: "shipments",      label: "Shipments",     emoji: "🚢", group: "Operations" },
  { key: "match",          label: "3-Way Match",   emoji: "🔍", group: "Operations" },
  { key: "messages",       label: "Messages",      emoji: "💬", group: "Operations" },
  { key: "phase_reviews",  label: "Phase reviews", emoji: "🧭", group: "Operations" },
  { key: "anomalies",      label: "Anomalies",     emoji: "🚨", group: "Operations" },
  { key: "workspaces",     label: "Workspaces",    emoji: "🗂️", group: "Operations" },

  // ── Compliance ──
  { key: "compliance",            label: "Documents",   emoji: "📋", group: "Compliance" },
  { key: "compliance_automation", label: "Automation",  emoji: "🤖", group: "Compliance" },
  { key: "compliance_audit",      label: "Audit trail", emoji: "📜", group: "Compliance" },

  // ── Sourcing ──
  { key: "rfqs",                  label: "RFQs",        emoji: "📨", group: "Sourcing" },
  { key: "marketplace",           label: "Marketplace", emoji: "🛍️", group: "Sourcing" },
  { key: "marketplace_inquiries", label: "Inquiries",   emoji: "💬", group: "Sourcing" },
  { key: "benchmark",             label: "Benchmark",   emoji: "📈", group: "Sourcing" },
  { key: "insights",              label: "Insights",    emoji: "💡", group: "Sourcing" },

  // ── Finance ──
  { key: "payments",        label: "Payments",        emoji: "💸", group: "Finance" },
  { key: "discount_offers", label: "Discount offers", emoji: "⚡", group: "Finance" },
  { key: "scf",             label: "SCF",             emoji: "🏦", group: "Finance" },
  { key: "virtual_cards",   label: "Virtual cards",   emoji: "💳", group: "Finance" },
  { key: "fx",              label: "FX",              emoji: "🌐", group: "Finance" },
  { key: "tax",             label: "Tax",             emoji: "🧾", group: "Finance" },

  // ── Analytics & Admin ──
  { key: "analytics",           label: "Analytics",      emoji: "📊", group: "Analytics & Admin" },
  { key: "spend",               label: "Spend",          emoji: "💰", group: "Analytics & Admin" },
  { key: "workflow_rules",      label: "Workflow Rules", emoji: "⚙️", group: "Analytics & Admin" },
  { key: "workflow_executions", label: "Approvals",      emoji: "✅", group: "Analytics & Admin" },
  { key: "entities",            label: "Entities",       emoji: "🏛️", group: "Analytics & Admin" },
];

export const TANDA_SECTIONS: NavSection[] = [
  { section: "Purchase Orders",   emoji: "📋", groups: ["Purchase Orders"] },
  { section: "Collaboration",     emoji: "💬", groups: ["Collaboration"] },
  { section: "Vendors",           emoji: "🏢", groups: ["Vendors"] },
  { section: "Operations",        emoji: "🚢", groups: ["Operations"] },
  { section: "Compliance",        emoji: "📋", groups: ["Compliance"] },
  { section: "Sourcing",          emoji: "📨", groups: ["Sourcing"] },
  { section: "Finance",           emoji: "💸", groups: ["Finance"] },
  { section: "Analytics & Admin", emoji: "📊", groups: ["Analytics & Admin"] },
];
