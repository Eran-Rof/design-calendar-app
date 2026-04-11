import { useEffect } from "react";

interface IdleLogoutOpts {
  enabled: boolean;
  idleMs: number;
  onWarning: (show: boolean) => void;
  onLogout: () => void;
}

/**
 * Auto-logout after idleMs of inactivity. Shows warning 5 minutes before.
 * Only dispatches state updates when the warning state actually changes
 * (avoids re-rendering the entire app on every mouse move).
 */
export function useIdleLogout({ enabled, idleMs, onWarning, onLogout }: IdleLogoutOpts) {
  useEffect(() => {
    if (!enabled) return;
    let warnTimer: ReturnType<typeof setTimeout> | null = null;
    let logoutTimer: ReturnType<typeof setTimeout> | null = null;
    let warningShown = false;

    function resetTimers() {
      if (warningShown) { onWarning(false); warningShown = false; }
      if (warnTimer) clearTimeout(warnTimer);
      if (logoutTimer) clearTimeout(logoutTimer);
      warnTimer = setTimeout(() => { warningShown = true; onWarning(true); }, idleMs - 5 * 60 * 1000);
      logoutTimer = setTimeout(onLogout, idleMs);
    }

    const EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click", "wheel"];
    EVENTS.forEach(ev => window.addEventListener(ev, resetTimers, { passive: true }));
    resetTimers();

    return () => {
      if (warnTimer) clearTimeout(warnTimer);
      if (logoutTimer) clearTimeout(logoutTimer);
      EVENTS.forEach(ev => window.removeEventListener(ev, resetTimers));
    };
  }, [enabled, idleMs]);
}
