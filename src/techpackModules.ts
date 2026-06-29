// Tech Pack nav module registry for the shared <NavDrawer>. Module keys are the
// TechPack `view` strings; groups/sections mirror src/lib/menuKeys.ts ("techpack/*"
// rows). Notifications is intentionally omitted here — it lives in the slim top
// bar with its unread badge, like GS1 and the other apps. The instance-only
// "detail" view is also omitted (reached by clicking a specific pack row).
import type { NavModule, NavSection } from "./tanda/NavDrawer";

export const TECHPACK_MODULES: NavModule[] = [
  { key: "dashboard", label: "Dashboard",  emoji: "🏠", group: "Main" },
  { key: "list",      label: "All Packs",  emoji: "📦", group: "Main" },
  { key: "libraries", label: "Libraries",  emoji: "📚", group: "Main" },
  { key: "samples",   label: "Samples",    emoji: "🧵", group: "Main" },
  { key: "teams",     label: "Teams",      emoji: "💬", group: "Communication" },
  { key: "email",     label: "Email",      emoji: "📧", group: "Communication" },
];

export const TECHPACK_SECTIONS: NavSection[] = [
  { section: "Main",          emoji: "🏠", groups: ["Main"] },
  { section: "Communication", emoji: "💬", groups: ["Communication"] },
];
