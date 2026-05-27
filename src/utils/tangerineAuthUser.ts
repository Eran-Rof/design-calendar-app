// src/utils/tangerineAuthUser.ts
//
// Tiny shared helper for the Tangerine cached auth.users.id. Centralizes the
// localStorage key + back-compat read so all three panels (Approval Requests
// inbox, Notification Center, Notification Preferences) read/write the same
// slot. The auth-bridge chunk replaces the manual "paste your uuid" prompts.
//
// Storage key:
//   tangerine.auth_user_id  — new (set by /api/internal/auth/provision on
//                              first MS sign-in, then cached for subsequent
//                              calls during this browser session)
//
// Legacy key (back-compat):
//   tangerine.notifications.user_id  — old key used by InternalNotification*
//                                      before the bridge existed. We read it
//                                      as a fallback so an operator who has
//                                      already typed their uuid into the
//                                      Notification Center input doesn't have
//                                      to re-paste after upgrade.

const NEW_KEY = "tangerine.auth_user_id";
const LEGACY_KEY = "tangerine.notifications.user_id";

export function getCachedAuthUserId(): string {
  try {
    const fresh = localStorage.getItem(NEW_KEY);
    if (fresh && fresh.trim()) return fresh.trim();
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && legacy.trim()) return legacy.trim();
  } catch (_) { /* SSR / private mode */ }
  return "";
}

export function setCachedAuthUserId(uid: string): void {
  try {
    const trimmed = (uid || "").trim();
    if (trimmed) {
      localStorage.setItem(NEW_KEY, trimmed);
      // Keep the legacy key in sync too, so panels that still read it (or
      // any other code we missed) Just Work without a follow-up fix.
      localStorage.setItem(LEGACY_KEY, trimmed);
    } else {
      localStorage.removeItem(NEW_KEY);
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch (_) { /* SSR / private mode */ }
}
