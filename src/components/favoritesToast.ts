// Cross-cutter T4-7 — Tiny pub/sub bus for favorites toasts.
//
// Used by `<CurrentViewFavoriteStar />` + the in-strip header star to
// surface "Added to favorites" / "Removed from favorites" feedback when
// the operator toggles favorite status. Deliberately stays in module
// scope (no Context) so any component anywhere can emit, and the
// renderer mounted by `<FavoritesDrawer />` will hear it.
//
// Why not reuse AutoLandingToast? That one is purpose-built for the
// auto-landing redirect message ("opened your default view") and reading
// it back-to-back with a favorite toggle conflates two unrelated UX
// events. A dedicated bus is ~30 lines and keeps both surfaces clear.

export type FavoritesToastKind = "added" | "removed" | "error";

export interface FavoritesToast {
  id: number;
  kind: FavoritesToastKind;
  message: string;
}

type Listener = (toast: FavoritesToast) => void;

const listeners = new Set<Listener>();
let nextId = 1;

export function emitFavoritesToast(kind: FavoritesToastKind, message: string): void {
  const toast: FavoritesToast = { id: nextId++, kind, message };
  for (const l of listeners) {
    try { l(toast); } catch { /* keep notifying others */ }
  }
}

export function subscribeFavoritesToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** @internal */
export function __resetFavoritesToastsForTests(): void {
  listeners.clear();
  nextId = 1;
}
