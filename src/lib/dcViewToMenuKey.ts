// Cross-cutter T4-5 — Design Calendar view-string → menu_key mapping.
//
// App.tsx tracks the active panel as a single `view` string (e.g.
// "dashboard", "timeline", "calendar"). The personalization registry
// (src/lib/menuKeys.ts) keys DC items as "dc/<slug>". This helper
// bridges the two so the nav onClick handlers can call
// `logClick(dcViewToMenuKey(view))` without each click site having
// to know the full registry shape.
//
// Returns null for unknown views (e.g. internal-only drill-downs that
// aren't in the registry). Callers should silently no-op on null.

const MAP: Record<string, string> = {
  dashboard:       "dc/dashboard",
  timeline:        "dc/timeline",
  calendar:        "dc/calendar",
  "trend-briefs":  "dc/trend-briefs",
  teams:           "dc/teams",
  email:           "dc/email",
  notifications:   "dc/notifications",
};

/**
 * Maps a Design Calendar view string to the corresponding menu_key in
 * the personalization registry, or null when the view isn't tracked.
 */
export function dcViewToMenuKey(view: string | null | undefined): string | null {
  if (!view) return null;
  return MAP[view] ?? null;
}
