// Cross-cutter T4-5 — Tech Pack view-string → menu_key mapping.
//
// TechPack.tsx tracks the active panel as a single `view` string of
// type View ("dashboard" | "list" | "detail" | "libraries" | "samples"
// | "teams" | "email" | "notifications"). The personalization registry
// keys Tech Pack items as "techpack/<slug>". This helper bridges the two.
//
// `detail` is intentionally omitted — it's an instance view reached by
// clicking a specific tech pack row, not a top-level nav destination,
// and we deliberately don't surface it in the registry. Callers will
// see null returned for `detail` and silently no-op.
//
// Returns null for unknown views. Callers should silently no-op on null.

const MAP: Record<string, string> = {
  dashboard:     "techpack/dashboard",
  list:          "techpack/list",
  libraries:     "techpack/libraries",
  samples:       "techpack/samples",
  teams:         "techpack/teams",
  email:         "techpack/email",
  notifications: "techpack/notifications",
};

/**
 * Maps a Tech Pack view string to the corresponding menu_key in the
 * personalization registry, or null when the view isn't tracked.
 */
export function techpackViewToMenuKey(view: string | null | undefined): string | null {
  if (!view) return null;
  return MAP[view] ?? null;
}
