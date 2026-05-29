// Cross-cutter T4-5 — ATS view-mode → menu_key mapping.
//
// ATS.tsx tracks the active grid pivot as a `viewMode` string of
// "ats" | "so" | "po" (toggled via the toolbar dropdown). The
// personalization registry keys the grid pivots as "ats/grid",
// "ats/grid-so", "ats/grid-po". This helper bridges the two so the
// nav toolbar onChange handler can call `logClick(atsViewToMenuKey(
// viewMode))` without each click site having to know the registry shape.
//
// ATS also exposes report destinations ("ats/reports/*") which live on
// the Reports dropdown in the NavBar — those click sites already know
// their menu_key statically and pass it directly to logClick, so they
// don't go through this mapping.
//
// Returns null for unknown view modes (defensive — keeps the helper
// total). Callers should silently no-op on null.

const MAP: Record<string, string> = {
  ats: "ats/grid",
  so:  "ats/grid-so",
  po:  "ats/grid-po",
};

/**
 * Maps an ATS viewMode string ("ats" | "so" | "po") to the corresponding
 * menu_key in the personalization registry, or null when the view isn't
 * tracked.
 */
export function atsViewToMenuKey(view: string | null | undefined): string | null {
  if (!view) return null;
  return MAP[view] ?? null;
}
