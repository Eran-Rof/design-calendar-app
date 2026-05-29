// Cross-cutter T4-5 — GS1 tab → menu_key mapping.
//
// GS1App tracks the active panel as a GS1Tab string (e.g. "company",
// "upc", "scale", "pa_unpacker"). The personalization registry keys
// GS1 items as "gs1/<slug>" (kebab-case). This helper bridges the
// underscore-tab convention used in the store to the kebab-case
// menu_key namespace.
//
// Returns null for unknown tabs (defensive). Callers should silently
// no-op on null.

const MAP: Record<string, string> = {
  company:       "gs1/company",
  upc:           "gs1/upc",
  scale:         "gs1/scale",
  gtins:         "gs1/gtins",
  upload:        "gs1/upload",
  pa_unpacker:   "gs1/pa-unpacker",
  labels:        "gs1/labels",
  templates:     "gs1/templates",
  cartons:       "gs1/cartons",
  receiving:     "gs1/receiving",
  exceptions:    "gs1/exceptions",
  notifications: "gs1/notifications",
};

/**
 * Maps a GS1 tab string to the corresponding menu_key in the
 * personalization registry, or null when the tab isn't tracked.
 */
export function gs1ViewToMenuKey(view: string | null | undefined): string | null {
  if (!view) return null;
  return MAP[view] ?? null;
}
