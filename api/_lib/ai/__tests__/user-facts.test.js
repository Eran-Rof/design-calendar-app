// Unit tests for the lookup_user_facts executor (Tier 2H).
// Pinned behaviours:
//   - Topic is matched case-insensitively as a substring.
//   - Results are ranked: operator's own facts first, then global (NULL user_id).
//   - App filter: row.app must match OR be NULL (= global app).
//   - user_id is NEVER read from `input` (the AI's tool args); only from `ctx`.
//   - Fact bodies trimmed to MAX_FACT_LEN to bound prompt-budget impact.
//   - Empty/whitespace topic returns a structured error.

import { describe, it, expect } from "vitest";
import {
  matchTopic,
  rankFacts,
  tool_lookup_user_facts,
} from "../executors-user-facts.js";

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

describe("matchTopic", () => {
  it("matches case-insensitively", () => {
    expect(matchTopic("RYB0412PPK24", "ryb0412")).toBe(true);
    expect(matchTopic("Burlington Coat Factory", "BURLINGTON")).toBe(true);
  });

  it("requires substring containment", () => {
    expect(matchTopic("Edge Jogger", "Bartram")).toBe(false);
  });

  it("returns false for empty or non-string inputs", () => {
    expect(matchTopic("", "x")).toBe(false);
    expect(matchTopic("x", "")).toBe(false);
    expect(matchTopic(null, "x")).toBe(false);
    expect(matchTopic("x", undefined)).toBe(false);
  });
});

describe("rankFacts", () => {
  const rows = [
    { id: "a", user_id: null,   topic: "g1" },
    { id: "b", user_id: "u123", topic: "own1" },
    { id: "c", user_id: null,   topic: "g2" },
    { id: "d", user_id: "u123", topic: "own2" },
  ];

  it("puts operator's own facts before global facts", () => {
    const out = rankFacts(rows, "u123");
    expect(out.map(r => r.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("with no userId, all non-global rows still come first (rare; defensive)", () => {
    const out = rankFacts(rows, null);
    // null user means we can't identify "own" vs "other"; global rows go last either way
    expect(out.map(r => r.id).slice(-2).sort()).toEqual(["a", "c"]);
  });

  it("returns [] for non-array input", () => {
    expect(rankFacts(null, "u")).toEqual([]);
    expect(rankFacts(undefined, "u")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Executor — fake Supabase builder
// ────────────────────────────────────────────────────────────────────────

// Records every call so tests can assert the chain shape, and returns
// the fixed `data` set when awaited.
function fakeDb(rows, error = null) {
  const builder = {
    _calls: [],
    from(t) { this._calls.push(["from", t]); return this; },
    select(s) { this._calls.push(["select", s]); return this; },
    ilike(c, v) { this._calls.push(["ilike", c, v]); return this; },
    order(c, opts) { this._calls.push(["order", c, opts]); return this; },
    limit(n) { this._calls.push(["limit", n]); return this; },
    then(resolve) { resolve({ data: rows, error }); },
  };
  return builder;
}

describe("tool_lookup_user_facts", () => {
  it("returns a structured error when topic is empty", async () => {
    const out = await tool_lookup_user_facts(fakeDb([]), { topic: "" }, {});
    expect(out.error).toMatch(/topic/);
  });

  it("returns a structured error when topic is whitespace only", async () => {
    const out = await tool_lookup_user_facts(fakeDb([]), { topic: "   " }, {});
    expect(out.error).toMatch(/topic/);
  });

  it("returns empty list when no rows match", async () => {
    const out = await tool_lookup_user_facts(fakeDb([]), { topic: "RYB0412" }, { user_id: "u1" });
    expect(out.count).toBe(0);
    expect(out.facts).toEqual([]);
    expect(out.topic).toBe("RYB0412");
  });

  it("escapes % and _ wildcards in the ilike query so an operator-typed % isn't injected", async () => {
    const db = fakeDb([]);
    await tool_lookup_user_facts(db, { topic: "50%_special" }, {});
    const ilikeCall = db._calls.find(c => c[0] === "ilike");
    expect(ilikeCall[2]).toBe("%50\\%\\_special%");
  });

  it("ranks own facts before global facts", async () => {
    const rows = [
      { id: "g1",  user_id: null,   app: null,  topic: "RYB0412 notes",     fact: "global fact",       updated_at: "2026-05-10T00:00:00Z" },
      { id: "own", user_id: "u123", app: "ats", topic: "RYB0412 watch list", fact: "own fact",          updated_at: "2026-05-15T00:00:00Z" },
    ];
    const out = await tool_lookup_user_facts(
      fakeDb(rows),
      { topic: "RYB0412" },
      { user_id: "u123", app: "ats" },
    );
    expect(out.count).toBe(2);
    expect(out.facts[0].id).toBe("own");
    expect(out.facts[0].scope).toBe("you");
    expect(out.facts[1].id).toBe("g1");
    expect(out.facts[1].scope).toBe("global");
  });

  it("filters out rows whose app doesn't match (and ctx.app is set)", async () => {
    const rows = [
      { id: "ats",  user_id: null, app: "ats",      topic: "x", fact: "ats fact",      updated_at: "2026-05-10T00:00:00Z" },
      { id: "plan", user_id: null, app: "planning", topic: "x", fact: "planning fact", updated_at: "2026-05-10T00:00:00Z" },
      { id: "any",  user_id: null, app: null,       topic: "x", fact: "global app",    updated_at: "2026-05-10T00:00:00Z" },
    ];
    const out = await tool_lookup_user_facts(
      fakeDb(rows),
      { topic: "x" },
      { app: "ats" },
    );
    const ids = out.facts.map(f => f.id);
    expect(ids).toContain("ats");
    expect(ids).toContain("any");
    expect(ids).not.toContain("plan");
  });

  it("caps results at 5 even when more rows match", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`, user_id: null, app: null, topic: "burlington note", fact: `fact ${i}`,
      updated_at: "2026-05-10T00:00:00Z",
    }));
    const out = await tool_lookup_user_facts(fakeDb(rows), { topic: "burlington" }, {});
    expect(out.count).toBe(5);
    expect(out.facts).toHaveLength(5);
  });

  it("trims long fact bodies to MAX_FACT_LEN (600)", async () => {
    const long = "x".repeat(2000);
    const rows = [
      { id: "long", user_id: null, app: null, topic: "topic", fact: long, updated_at: "2026-05-10T00:00:00Z" },
    ];
    const out = await tool_lookup_user_facts(fakeDb(rows), { topic: "topic" }, {});
    expect(out.facts[0].fact.length).toBe(600);
  });

  it("propagates DB errors as a structured error payload (no throw)", async () => {
    const out = await tool_lookup_user_facts(fakeDb(null, { message: "denied" }), { topic: "x" }, {});
    expect(out.error).toMatch(/ip_ai_user_facts read failed/);
    expect(out.error).toMatch(/denied/);
  });

  it("IGNORES user_id supplied via input — only ctx is trusted", async () => {
    const rows = [
      { id: "g", user_id: null, app: null, topic: "x", fact: "g", updated_at: "2026-05-10T00:00:00Z" },
    ];
    // No ctx → scope should report "global" not "you", even if input lies about user_id.
    const out = await tool_lookup_user_facts(
      fakeDb(rows),
      { topic: "x", user_id: "attacker_user" }, // <-- AI input that must NOT be trusted
      {}, // empty ctx
    );
    expect(out.facts[0].scope).toBe("global");
  });
});
