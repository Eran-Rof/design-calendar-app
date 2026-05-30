// src/utils/tangerineAuthUser.ts
//
// Tiny shared helper for the Tangerine cached auth.users.id + signed-in email.
// Centralizes the localStorage keys + back-compat read so all panels read/write
// the same slot. The auth-bridge chunk replaces the manual "paste your uuid"
// prompts and the Style Master notes log (2026-05-30) reads the email
// snapshot to tag each note.
//
// Storage keys:
//   tangerine.auth_user_id     — auth.users.id (set by /api/internal/auth/provision
//                                 on first MS sign-in, then cached for the
//                                 browser session).
//   tangerine.auth_user_email  — snapshot of the signed-in email (mail or UPN)
//                                 from MS Graph /me; used by audit-style UIs
//                                 like the Style Master notes log.
//
// Legacy key (back-compat for user_id):
//   tangerine.notifications.user_id  — old key used by InternalNotification*
//                                      before the bridge existed. Read as a
//                                      fallback so a previously-pasted uuid
//                                      keeps working after upgrade.

const NEW_KEY        = "tangerine.auth_user_id";
const LEGACY_KEY     = "tangerine.notifications.user_id";
const EMAIL_KEY      = "tangerine.auth_user_email";

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

export function getCachedAuthUserEmail(): string {
  try {
    const v = localStorage.getItem(EMAIL_KEY);
    if (v && v.trim()) return v.trim();
  } catch (_) { /* SSR / private mode */ }
  return "";
}

export function setCachedAuthUserEmail(email: string | null | undefined): void {
  try {
    const trimmed = (email || "").trim();
    if (trimmed) localStorage.setItem(EMAIL_KEY, trimmed);
    else        localStorage.removeItem(EMAIL_KEY);
  } catch (_) { /* SSR / private mode */ }
}
