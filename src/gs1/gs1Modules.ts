// GS1 nav module registry for the shared <NavDrawer>. Module keys are the
// gs1Store tab ids; groups/sections mirror src/lib/menuKeys.ts ("gs1/*" rows).
// Notifications is intentionally omitted here — it lives in the slim top bar
// with its unread badge, like the other apps.
import type { NavModule, NavSection } from "../tanda/NavDrawer";

export const GS1_MODULES: NavModule[] = [
  { key: "company",     label: "Company Setup",   emoji: "🏢", group: "Setup" },
  { key: "upc",         label: "UPC Master",      emoji: "🔢", group: "Masters" },
  { key: "scale",       label: "Scale Master",    emoji: "📏", group: "Masters" },
  { key: "gtins",       label: "Pack GTINs",      emoji: "🔖", group: "Masters" },
  { key: "catalog",     label: "Styles Catalog",  emoji: "📚", group: "Catalog" },
  { key: "upload",      label: "Packing List",    emoji: "📤", group: "Workflow" },
  { key: "pa_unpacker", label: "PA Unpacker",     emoji: "📦", group: "Workflow" },
  { key: "receiving",   label: "Receiving",       emoji: "📥", group: "Workflow" },
  { key: "exceptions",  label: "Exceptions",      emoji: "⚠️", group: "Workflow" },
  { key: "labels",      label: "Label Batches",   emoji: "🏷️", group: "Labels" },
  { key: "templates",   label: "Label Templates", emoji: "📋", group: "Labels" },
  { key: "cartons",     label: "Carton Labels",   emoji: "🗳️", group: "Labels" },
  { key: "edi_workflow", label: "Workflow Guide", emoji: "📖", group: "Help" },
];

export const GS1_SECTIONS: NavSection[] = [
  { section: "Setup",    emoji: "🏢", groups: ["Setup"] },
  { section: "Masters",  emoji: "🔢", groups: ["Masters"] },
  { section: "Catalog",  emoji: "📚", groups: ["Catalog"] },
  { section: "Workflow", emoji: "📦", groups: ["Workflow"] },
  { section: "Labels",   emoji: "🏷️", groups: ["Labels"] },
  { section: "Help",     emoji: "📖", groups: ["Help"] },
];
