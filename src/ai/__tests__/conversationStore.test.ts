// Tests for the conversation-memory store (Tier 2E of the Ask AI plan).
// Pinned behaviours:
//   - Key is namespaced by both appId and userId so different operators
//     + apps never share a bucket (privacy + relevance).
//   - 30-day TTL kicks in cleanly + expired entries self-clear.
//   - trimForStorage caps user/assistant pairs at MAX_TURNS so localStorage
//     doesn't grow unbounded.
//   - Malformed / non-array / non-message payloads return null instead
//     of poisoning the panel's render.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  loadConversation,
  saveConversation,
  clearConversation,
  trimForStorage,
  type StoredChatMessage,
} from "../conversationStore";

// Fake Storage impl so tests can run in node env (no jsdom needed).
function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => { data.clear(); },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  };
}

const APP = "ats";
const USER = "u123";

function msg(over: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return { id: "m" + Math.random().toString(36).slice(2, 6), role: "user", text: "hello", ...over };
}

// ────────────────────────────────────────────────────────────────────────
// trimForStorage
// ────────────────────────────────────────────────────────────────────────

describe("trimForStorage", () => {
  it("keeps everything when under the cap", () => {
    const m = [
      msg({ role: "user",      text: "q1" }),
      msg({ role: "assistant", text: "a1" }),
      msg({ role: "user",      text: "q2" }),
      msg({ role: "assistant", text: "a2" }),
    ];
    expect(trimForStorage(m)).toEqual(m);
  });

  it("trims to the last 10 user/assistant pairs (= 20 messages)", () => {
    const m: StoredChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      m.push(msg({ role: "user",      text: `q${i}` }));
      m.push(msg({ role: "assistant", text: `a${i}` }));
    }
    const out = trimForStorage(m);
    expect(out.length).toBe(20);
    // Should be the last 20 messages — q20/a20 through q29/a29
    expect(out[0].text).toBe("q20");
    expect(out[19].text).toBe("a29");
  });

  it("drops empty / whitespace-only / wrong-role messages", () => {
    const m: StoredChatMessage[] = [
      msg({ role: "user", text: "" }),
      msg({ role: "user", text: "   " }),
      msg({ role: "user", text: "real" }),
      msg({ role: "system" as any, text: "ignored bad role" } as any),
    ];
    const out = trimForStorage(m);
    expect(out.length).toBe(2); // "real" + the system message (system IS kept)
    expect(out.find(x => x.text === "real")).toBeTruthy();
  });

  it("preserves system messages on top of the trim cap", () => {
    const m: StoredChatMessage[] = [
      msg({ role: "system", text: "system note" }),
    ];
    for (let i = 0; i < 25; i++) {
      m.push(msg({ role: "user",      text: `q${i}` }));
      m.push(msg({ role: "assistant", text: `a${i}` }));
    }
    const out = trimForStorage(m);
    // System message preserved + 20 most recent u/a (last 10 pairs)
    expect(out.find(x => x.text === "system note")).toBeTruthy();
    expect(out.find(x => x.text === "q15")).toBeTruthy(); // 25 - 10 = pair 15 onward
    expect(out.find(x => x.text === "q14")).toBeFalsy();   // trimmed
  });
});

// ────────────────────────────────────────────────────────────────────────
// save + load round-trip
// ────────────────────────────────────────────────────────────────────────

describe("save + load round-trip", () => {
  let storage: Storage;
  beforeEach(() => { storage = makeStorage(); });

  it("returns null when nothing stored", () => {
    expect(loadConversation(APP, USER, storage)).toBeNull();
  });

  it("round-trips a small conversation verbatim", () => {
    const conv: StoredChatMessage[] = [
      msg({ id: "1", role: "user",      text: "Hi" }),
      msg({ id: "2", role: "assistant", text: "Hello" }),
    ];
    saveConversation(APP, USER, conv, storage);
    const loaded = loadConversation(APP, USER, storage);
    expect(loaded).toEqual(conv);
  });

  it("namespaces by (appId, userId) — different combos see different state", () => {
    saveConversation("ats", "u1", [msg({ text: "ats-u1" })], storage);
    saveConversation("dc",  "u1", [msg({ text: "dc-u1"  })], storage);
    saveConversation("ats", "u2", [msg({ text: "ats-u2" })], storage);

    expect(loadConversation("ats", "u1", storage)?.[0].text).toBe("ats-u1");
    expect(loadConversation("dc",  "u1", storage)?.[0].text).toBe("dc-u1");
    expect(loadConversation("ats", "u2", storage)?.[0].text).toBe("ats-u2");
    expect(loadConversation("po_wip", "u1", storage)).toBeNull();
  });

  it("saving an empty list clears the slot", () => {
    saveConversation(APP, USER, [msg({ text: "x" })], storage);
    expect(loadConversation(APP, USER, storage)).not.toBeNull();
    saveConversation(APP, USER, [], storage);
    expect(loadConversation(APP, USER, storage)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// TTL + expired entries
// ────────────────────────────────────────────────────────────────────────

describe("TTL", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = makeStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("returns the entry when stored under 30 days ago", () => {
    saveConversation(APP, USER, [msg({ text: "fresh" })], storage);
    // Jump forward 29 days
    vi.setSystemTime(new Date("2026-06-30T00:00:00Z"));
    expect(loadConversation(APP, USER, storage)?.[0].text).toBe("fresh");
  });

  it("returns null + self-clears when stored over 30 days ago", () => {
    saveConversation(APP, USER, [msg({ text: "stale" })], storage);
    // Jump forward 31 days — past TTL
    vi.setSystemTime(new Date("2026-07-02T00:00:00Z"));
    expect(loadConversation(APP, USER, storage)).toBeNull();
    // Self-clear: the slot should be empty so the next save lands cleanly.
    expect(storage.getItem("ai_conversation_ats_u123")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Malformed payloads
// ────────────────────────────────────────────────────────────────────────

describe("malformed payloads", () => {
  let storage: Storage;
  beforeEach(() => { storage = makeStorage(); });

  it("returns null on invalid JSON", () => {
    storage.setItem("ai_conversation_ats_u123", "not valid json {{{");
    expect(loadConversation(APP, USER, storage)).toBeNull();
  });

  it("returns null when payload is missing messages array", () => {
    storage.setItem("ai_conversation_ats_u123", JSON.stringify({ savedAt: new Date().toISOString() }));
    expect(loadConversation(APP, USER, storage)).toBeNull();
  });

  it("returns null when payload is not an object", () => {
    storage.setItem("ai_conversation_ats_u123", JSON.stringify("just a string"));
    expect(loadConversation(APP, USER, storage)).toBeNull();
  });

  it("drops individual messages that fail shape check", () => {
    storage.setItem("ai_conversation_ats_u123", JSON.stringify({
      savedAt: new Date().toISOString(),
      messages: [
        { id: "good", role: "user", text: "ok" },
        { id: 999, role: "user", text: "bad id (not string)" }, // dropped
        null,                                                   // dropped
        { id: "bad-role", role: "robot", text: "no" },          // dropped
        { id: "no-text", role: "user" },                        // dropped
      ],
    }));
    const out = loadConversation(APP, USER, storage);
    expect(out?.length).toBe(1);
    expect(out?.[0].id).toBe("good");
  });
});

// ────────────────────────────────────────────────────────────────────────
// clearConversation
// ────────────────────────────────────────────────────────────────────────

describe("clearConversation", () => {
  it("removes the stored entry for that (appId, userId)", () => {
    const storage = makeStorage();
    saveConversation(APP, USER, [msg({ text: "x" })], storage);
    expect(loadConversation(APP, USER, storage)).not.toBeNull();
    clearConversation(APP, USER, storage);
    expect(loadConversation(APP, USER, storage)).toBeNull();
  });

  it("doesn't touch other (appId, userId) buckets", () => {
    const storage = makeStorage();
    saveConversation("ats", "u1", [msg({ text: "a" })], storage);
    saveConversation("dc",  "u1", [msg({ text: "b" })], storage);
    clearConversation("ats", "u1", storage);
    expect(loadConversation("ats", "u1", storage)).toBeNull();
    expect(loadConversation("dc",  "u1", storage)?.[0].text).toBe("b");
  });

  it("is idempotent on a non-existent key", () => {
    const storage = makeStorage();
    expect(() => clearConversation("ats", "u999", storage)).not.toThrow();
  });
});


// ── P28-3: day-scoped threads (tangerine) ───────────────────────────────
import { isStaleForDayScope, localDay } from "../conversationStore";

describe("isStaleForDayScope", () => {
  const now = new Date("2026-07-14T15:00:00");
  it("tangerine threads roll at local midnight", () => {
    expect(isStaleForDayScope("tangerine", "2026-07-14T08:00:00", now)).toBe(false);
    expect(isStaleForDayScope("tangerine", "2026-07-13T23:59:00", now)).toBe(true);
    expect(isStaleForDayScope("tangerine", null, now)).toBe(true);
    expect(isStaleForDayScope("tangerine", "garbage", now)).toBe(true);
  });
  it("other apps keep the 30-day TTL (never day-stale)", () => {
    expect(isStaleForDayScope("ats", "2026-06-20T08:00:00", now)).toBe(false);
    expect(isStaleForDayScope("", null, now)).toBe(false);
  });
  it("localDay formats the local calendar date", () => {
    expect(localDay(new Date(2026, 6, 14, 23, 59))).toBe("2026-07-14");
  });
});
