// localStorage-backed conversation memory for the Ask AI panel.
// Tier 2E of the Ask AI improvement plan.
//
// Why localStorage (not a Supabase table): internal staff use sessionStorage.plm_user
// for auth, so per-user keys are already available client-side. localStorage is
// cross-tab + per-machine; the common case (one operator on one laptop) just works.
// Upgrade to a Supabase `ip_ai_conversation_state` table is a follow-up when
// cross-device sync becomes a real need.
//
// Key shape:   ai_conversation_<appId>_<userId>
// Value shape: { savedAt: <ISO>, messages: [{ id, role, text, ... }] }
// TTL:         30 days from savedAt; older payloads return null + clear themselves
// Cap:         last 10 user+assistant pairs (= 20 messages); older trimmed on save

const KEY_PREFIX  = "ai_conversation_";
const TTL_DAYS    = 30;
const MAX_TURNS   = 10;  // 10 user/assistant pairs = 20 messages

// P28-3 companion mode: apps where the conversation is ONE THREAD PER DAY
// (the morning brief starts a fresh context each day; yesterday's thread
// restoring at 9am reads as stale). Other apps keep the 30-day TTL.
const DAY_SCOPED_APPS = new Set(["tangerine"]);

/** Local calendar date (operator's clock) — day threads roll at midnight
 *  where the operator sits, not UTC. Exported for tests. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Should a stored thread be discarded under day-scoping? Pure; tested. */
export function isStaleForDayScope(appId: string, savedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!DAY_SCOPED_APPS.has(String(appId || ""))) return false;
  if (!savedAt) return true;
  const t = new Date(savedAt);
  if (!Number.isFinite(t.getTime())) return true;
  return localDay(t) !== localDay(now);
}

/** Subset of ChatMessage that's safe to persist (no React-specific state). */
export interface StoredChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  // Optional metadata kept so restored bubbles render the same affordances
  // they had on first display (filters applied, follow-ups visible, etc.).
  actionLabel?: string;
  suggestionPushed?: boolean;
  cached?: boolean;
  cachedAgeSeconds?: number;
}

interface StoredConversation {
  savedAt:  string;          // ISO timestamp
  messages: StoredChatMessage[];
}

function keyFor(appId: string, userId: string): string {
  // Sanitise both parts so any odd chars in operator ids don't break the key.
  const a = String(appId  || "default").replace(/[^a-z0-9_-]/gi, "_");
  const u = String(userId || "anon").replace(/[^a-z0-9_-]/gi, "_");
  return `${KEY_PREFIX}${a}_${u}`;
}

function isExpired(savedAt: string | null | undefined): boolean {
  if (!savedAt) return true;
  const t = new Date(savedAt).getTime();
  if (!Number.isFinite(t)) return true;
  const ageMs = Date.now() - t;
  return ageMs > TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Trim a message list to the most recent MAX_TURNS user/assistant pairs.
 * System messages stay in place (they're rare + carry context the operator
 * likely wants kept). Pending / error bubbles are dropped — restoring an
 * "Error: HTTP 500" bubble from yesterday is just confusing.
 */
export function trimForStorage(messages: StoredChatMessage[]): StoredChatMessage[] {
  // Drop anything that wouldn't be useful on restore.
  const clean = messages.filter(m => {
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") return false;
    if (!m.text || !m.text.trim()) return false;
    return true;
  });
  // Count from the END: keep the last MAX_TURNS user+assistant pairs (= 2×N msgs),
  // plus any system messages encountered along the way.
  const limit = MAX_TURNS * 2;
  let userAssistantSeen = 0;
  const reverseKept: StoredChatMessage[] = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    const m = clean[i];
    if (m.role === "system") {
      reverseKept.push(m);
      continue;
    }
    if (userAssistantSeen >= limit) continue;
    reverseKept.push(m);
    userAssistantSeen++;
  }
  return reverseKept.reverse();
}

/**
 * Load the persisted conversation for (appId, userId). Returns null when
 * nothing stored, when the stored payload is malformed, or when expired
 * (in which case the expired entry is removed as a side effect).
 *
 * `appId` and `userId` defaults are forgiving so callers that haven't
 * wired both yet still get correct behaviour (single shared bucket).
 */
export function loadConversation(
  appId: string,
  userId: string,
  storage: Storage = localStorage,
): StoredChatMessage[] | null {
  let raw: string | null = null;
  try { raw = storage.getItem(keyFor(appId, userId)); }
  catch { return null; }
  if (!raw) return null;

  let parsed: StoredConversation;
  try { parsed = JSON.parse(raw) as StoredConversation; }
  catch { return null; }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) return null;

  if (isExpired(parsed.savedAt) || isStaleForDayScope(appId, parsed.savedAt)) {
    // Reclaim the slot — keeps localStorage tidy for the next session.
    try { storage.removeItem(keyFor(appId, userId)); } catch { /* ignore */ }
    return null;
  }

  // Defensive shape-check on each message — drop any that look corrupt.
  const clean = parsed.messages.filter((m): m is StoredChatMessage =>
    !!m
    && typeof m.id === "string"
    && (m.role === "user" || m.role === "assistant" || m.role === "system")
    && typeof m.text === "string",
  );
  return clean.length > 0 ? clean : null;
}

/**
 * Save the conversation. Trims to MAX_TURNS pairs before writing so
 * localStorage doesn't grow unbounded. Empty input clears the slot.
 */
export function saveConversation(
  appId: string,
  userId: string,
  messages: StoredChatMessage[],
  storage: Storage = localStorage,
): void {
  const key = keyFor(appId, userId);
  if (!Array.isArray(messages) || messages.length === 0) {
    try { storage.removeItem(key); } catch { /* ignore quota / disabled */ }
    return;
  }
  const trimmed = trimForStorage(messages);
  if (trimmed.length === 0) {
    try { storage.removeItem(key); } catch { /* ignore */ }
    return;
  }
  const payload: StoredConversation = {
    savedAt:  new Date().toISOString(),
    messages: trimmed,
  };
  try { storage.setItem(key, JSON.stringify(payload)); }
  catch { /* ignore — localStorage full or disabled */ }
}

/**
 * Clear the persisted conversation for (appId, userId). Idempotent.
 */
export function clearConversation(
  appId: string,
  userId: string,
  storage: Storage = localStorage,
): void {
  try { storage.removeItem(keyFor(appId, userId)); } catch { /* ignore */ }
}
