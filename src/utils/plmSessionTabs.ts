// Cross-tab coordination for PLM idle auto-logout.
//
// Every PLM app keeps its session in PER-TAB `sessionStorage` (`plm_user`), so
// without coordination each open tab times out on its own and lands on its own
// copy of the login screen — N idle tabs become N login screens. This module
// collapses that down to a single login tab:
//
//   * A tab sitting on the PLM login screen announces itself on a shared
//     BroadcastChannel and answers "is anyone at login?" pings
//     (registerLoginPresence).
//   * When a tab times out it clears its session, asks whether a login tab is
//     already open, and either becomes the one login tab (none open) or retires
//     itself (one already open). Retiring means window.close(); tabs the browser
//     refuses to script-close instead show a small "signed out — you can close
//     this tab" stub so the user never sees a wall of duplicate login forms.
//
// Presence is liveness-based (ping / response), not a guessed timeout, so it
// works even when tabs time out minutes apart. A short localStorage claim lock
// breaks the tie when two tabs happen to time out within the same instant
// (before either has reached the login screen to answer pings).

const CHANNEL = "rof_plm_session";
const PING = "plm:who-is-at-login";
const HERE = "plm:at-login";

// Marker the retired-tab stub watches for (see PLM.tsx). Kept here so both
// sides agree on the spelling.
export const SIGNED_OUT_PARAM = "signedout";

const CLAIM_KEY = "rof_plm_login_claim";
const CLAIM_TTL_MS = 4000;
const PING_WAIT_MS = 250;

function makeChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

// Win the right to be the single login tab when no login tab is open yet.
// Last-writer-wins on a short-lived localStorage token; the re-read catches a
// racing tab that overwrote us. Defaults to true if storage is unavailable.
function claimBecomingLogin(): boolean {
  try {
    const now = Date.now();
    const prev = Number(localStorage.getItem(CLAIM_KEY) || "0");
    if (now - prev < CLAIM_TTL_MS) return false;
    const token = `${now}:${Math.random()}`;
    localStorage.setItem(CLAIM_KEY, token);
    return localStorage.getItem(CLAIM_KEY) === token;
  } catch {
    return true;
  }
}

// Retire a redundant tab: try to close it, and if the browser won't allow that
// (tab wasn't opened by script), fall back to a minimal signed-out stub rather
// than a second copy of the login form.
function retireTab(): void {
  try {
    window.close();
  } catch {
    /* noop */
  }
  // window.close() is a silent no-op for tabs the script didn't open, so if
  // we're still here a moment later, show the stub.
  setTimeout(() => {
    window.location.replace(`/?${SIGNED_OUT_PARAM}=1`);
  }, 200);
}

/**
 * Call while the PLM login screen is showing. Announces this tab as a live
 * login tab and answers presence pings from tabs that are timing out, so they
 * retire instead of opening another login screen. Returns a cleanup function.
 */
export function registerLoginPresence(): () => void {
  const ch = makeChannel();
  if (!ch) return () => {};
  const onMessage = (e: MessageEvent) => {
    if (e?.data === PING) {
      try {
        ch.postMessage(HERE);
      } catch {
        /* noop */
      }
    }
  };
  ch.addEventListener("message", onMessage);
  // Announce on arrival so a tab that timed out a moment earlier also hears us.
  try {
    ch.postMessage(HERE);
  } catch {
    /* noop */
  }
  return () => {
    try {
      ch.removeEventListener("message", onMessage);
      ch.close();
    } catch {
      /* noop */
    }
  };
}

/**
 * Idle-logout action for any PLM tab. Clears the per-tab session, then leaves
 * exactly one login tab open across the whole browser: if a login tab already
 * exists this tab retires; otherwise this tab navigates to the login screen and
 * becomes that single tab.
 */
export function collapseTabsToLogin(): void {
  try {
    sessionStorage.removeItem("plm_user");
  } catch {
    /* noop */
  }

  const ch = makeChannel();
  if (!ch) {
    window.location.href = "/";
    return;
  }

  let loginTabExists = false;
  const onMessage = (e: MessageEvent) => {
    if (e?.data === HERE) loginTabExists = true;
  };
  ch.addEventListener("message", onMessage);
  try {
    ch.postMessage(PING);
  } catch {
    /* noop */
  }

  // Give any live login tab a moment to answer the ping.
  setTimeout(() => {
    try {
      ch.removeEventListener("message", onMessage);
      ch.close();
    } catch {
      /* noop */
    }
    if (loginTabExists) {
      // A login tab is already open — this one is redundant.
      retireTab();
    } else if (claimBecomingLogin()) {
      // No login tab yet and we won the claim — become the single login tab.
      window.location.href = "/";
    } else {
      // A sibling that timed out at the same instant won the claim.
      retireTab();
    }
  }, PING_WAIT_MS);
}
