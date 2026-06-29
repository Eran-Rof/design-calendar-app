// Costing nav module registry for the shared <NavDrawer>. Module keys are the
// helpers.ts query-string `view` ids; groups/sections mirror the costing/* rows
// in src/lib/costingViewToMenuKey.ts. The detail views (edit / rfq-edit) are
// drill-downs reached from their parent list, so they are intentionally omitted
// from the drawer. Messages lives in the drawer (it is a top-level view), like
// the other apps' top-bar items.
import type { NavModule, NavSection } from "../tanda/NavDrawer";

export const COSTING_MODULES: NavModule[] = [
  { key: "list",        label: "Projects",     emoji: "📁", group: "Projects" },
  { key: "rfq-list",    label: "RFQs",         emoji: "📝", group: "RFQ" },
  { key: "rfq-compare", label: "Compare RFQs", emoji: "📊", group: "RFQ" },
  { key: "messages",    label: "Messages",     emoji: "💬", group: "RFQ" },
  { key: "settings",    label: "Masters",      emoji: "⚙️", group: "Setup" },
];

export const COSTING_SECTIONS: NavSection[] = [
  { section: "Projects", emoji: "📁", groups: ["Projects"] },
  { section: "RFQ",      emoji: "📝", groups: ["RFQ"] },
  { section: "Setup",    emoji: "⚙️", groups: ["Setup"] },
];
