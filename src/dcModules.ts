// Design Calendar nav module registry for the shared <NavDrawer>. Module keys
// are the App.tsx `view` strings; groups/sections mirror src/lib/menuKeys.ts
// ("dc/*" rows). Notifications is intentionally omitted here — it lives in the
// header with its unread badge, like the other apps (GS1 etc.).
import type { NavModule, NavSection } from "./tanda/NavDrawer";

export const DC_MODULES: NavModule[] = [
  { key: "dashboard",     label: "Dashboard",    emoji: "📊", group: "Calendar" },
  { key: "timeline",      label: "Timeline",     emoji: "📈", group: "Calendar" },
  { key: "calendar",      label: "Calendar",     emoji: "📅", group: "Calendar" },
  { key: "trend-briefs",  label: "Trend Briefs", emoji: "💡", group: "Calendar" },
  { key: "teams",         label: "Teams",        emoji: "💬", group: "Communication" },
  { key: "email",         label: "Email",        emoji: "📧", group: "Communication" },
];

export const DC_SECTIONS: NavSection[] = [
  { section: "Calendar",      emoji: "📅", groups: ["Calendar"] },
  { section: "Communication", emoji: "💬", groups: ["Communication"] },
];
