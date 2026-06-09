// Vanilla idle auto-logout installer for internal sub-apps that don't mount
// their own timer (PLM launcher, TandA, TechPack, ATS, Planning, GS1, etc.).
//
// Design Calendar (App.tsx) installs its own React-based useIdleLogout so it
// can render a 5-minute warning banner; that path skips this installer to
// avoid two parallel timers. The vendor portal uses Supabase Auth and is
// also skipped at the call site.
//
// All internal apps share `sessionStorage.plm_user` as the session token, so
// clearing it + redirecting to "/" (PLM launcher login) is enough. When several
// tabs are open and each times out, collapseTabsToLogin() coordinates them
// across the browser so only one login tab remains (the rest close).

import { collapseTabsToLogin } from "./plmSessionTabs";

const IDLE_MS = 60 * 60 * 1000;

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
  "click",
  "wheel",
] as const;

export function installIdleLogout(): void {
  let logoutTimer: ReturnType<typeof setTimeout> | null = null;

  function logout() {
    collapseTabsToLogin();
  }

  function reset() {
    if (!sessionStorage.getItem("plm_user")) return;
    if (logoutTimer) clearTimeout(logoutTimer);
    logoutTimer = setTimeout(logout, IDLE_MS);
  }

  ACTIVITY_EVENTS.forEach(ev =>
    window.addEventListener(ev, reset, { passive: true }),
  );
  reset();
}
