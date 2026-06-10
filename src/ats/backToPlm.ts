// "← PLM" navigation for the ATS app.
//
// The PLM launcher opens ATS in its own tab via `window.open("/ats", …)`
// (no `noopener`), so the ATS tab keeps a live `window.opener` pointing at the
// launcher. The old back-button did `window.location.href = "/"`, which turned
// THIS tab into a second launcher while the original launcher stayed open —
// every round-trip spawned another duplicate launcher.
//
// Instead: if we have a usable same-origin opener (the launcher), focus it and
// close this tab — the operator lands back on the launcher they came from,
// with no duplicate. When there's no opener (ATS opened directly by URL, or the
// launcher was closed), fall back to navigating this tab to "/".
//
// Scoped to ATS on purpose — the general cross-app version lives in the
// launcher (PLM) itself.

/** True when window.opener is a live, same-origin window we can return to. */
function hasUsableOpener(): boolean {
  try {
    const o = window.opener as Window | null;
    if (!o || o.closed) return false;
    // Reading location.href throws for a cross-origin opener — restrict to our
    // own origin so we never focus/close toward an unrelated site's tab.
    return o.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Return to the PLM launcher. Focuses the opener tab and closes this one when
 * possible; otherwise navigates this tab to "/". Safe to call from any ATS
 * surface.
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
