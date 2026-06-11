// Shared "← PLM" navigation for every internal app.
//
// The PLM launcher opens each app in its own tab via `window.open("/<app>", …)`
// (no `noopener`), so the app tab keeps a live `window.opener` pointing back at
// the launcher. A back-button that did `window.location.href = "/"` turned THIS
// tab into a SECOND launcher while the original launcher stayed open — every
// round-trip spawned another duplicate launcher.
//
// Instead: when we have a usable same-origin opener (the launcher), focus it and
// close this tab — the operator lands back on the launcher they came from, with
// no duplicate. When there's no opener (the app was opened directly by URL, or
// the launcher tab was closed), fall back to navigating this tab to "/".
//
// ATS shipped this first (src/ats/backToPlm.ts, #1200); this is the shared
// version wired into all the other apps. ats/backToPlm.ts now re-exports it.

/** True when window.opener is a live, same-origin window we can return to. */
function hasUsableOpener(): boolean {
  try {
    const o = window.opener as Window | null;
    if (!o || o.closed) return false;
    // Reading location.origin throws for a cross-origin opener — restrict to
    // our own origin so we never focus/close toward an unrelated site's tab.
    return o.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Return to the PLM launcher. Focuses the opener tab and closes this one when
 * possible; otherwise navigates this tab to "/". Safe to call from any app.
 */
export function backToPlmHome(): void {
  if (hasUsableOpener()) {
    try {
      window.opener!.focus();
      window.close();
      // window.close() is a no-op if the browser refuses (rare for a
      // script-opened tab). If we're still here shortly after, navigate.
      setTimeout(() => {
        if (!window.closed) window.location.href = "/";
      }, 200);
      return;
    } catch {
      /* fall through to navigation */
    }
  }
  window.location.href = "/";
}
