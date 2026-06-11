// Costing view-string → menu_key mapping.
//
// CostingApp tracks the active panel as a single `view` string (via the
// ?view= query param + helpers.navigate). The personalization registry
// (src/lib/menuKeys.ts) keys Costing items as "costing/<slug>". This helper
// bridges the two so any future nav onClick can call
// `logClick(costingViewToMenuKey(view))` without each click site having to
// know the full registry shape (mirrors src/lib/dcViewToMenuKey.ts).
//
// Detail views (edit / rfq-edit) are drill-downs collapsed under their parent
// list, so they map to the parent's menu_key. Returns null for unknown views.

const MAP: Record<string, string> = {
  list:          "costing/list",
  edit:          "costing/list",
  "rfq-list":    "costing/rfq-list",
  "rfq-edit":    "costing/rfq-list",
  "rfq-compare": "costing/rfq-compare",
  messages:      "costing/messages",
  settings:      "costing/settings",
};

/**
 * Maps a Costing view string to the corresponding menu_key in the
 * personalization registry, or null when the view isn't tracked.
 */
export function costingViewToMenuKey(view: string | null | undefined): string | null {
  if (!view) return null;
  return MAP[view] ?? null;
}
