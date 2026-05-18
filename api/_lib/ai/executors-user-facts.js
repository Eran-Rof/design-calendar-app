// Operator-authored fact lookup for the Ask AI handler (Tier 2H).
//
// Reads ip_ai_user_facts and returns up to N facts matching a topic
// (substring, case-insensitive). Scope: per-(user_id, app) facts win
// over global facts; global facts are still included when the
// per-user search comes up short.
//
// Why a separate executor module: same arch invariant as cards/margin
// — executors.js stays under the 700-line ceiling. New executors
// belong in their own file alongside this one.

import { clampString } from "./utils.js";

// Max facts returned per call. Each fact body is also trimmed to
// MAX_FACT_LEN chars to bound the token cost when many long facts
// match the same topic.
const MAX_RESULTS    = 5;
const MAX_FACT_LEN   = 600;
const MAX_TOPIC_LEN  = 80;

/**
 * Pure substring matcher. Returns true if `query` (lowercased) appears
 * anywhere in `topic` (lowercased). Pulled out so the matching rule
 * stays unit-testable without spinning a fake DB.
 */
export function matchTopic(topic, query) {
  if (typeof topic !== "string" || typeof query !== "string") return false;
  if (!topic || !query) return false;
  return topic.toLowerCase().includes(query.toLowerCase());
}

/**
 * Rank fetched rows: per-user first, then global. Within each bucket
 * keep DB order (which the executor sets to most-recently-updated).
 */
export function rankFacts(rows, userId) {
  if (!Array.isArray(rows)) return [];
  const own = [];
  const global = [];
  for (const r of rows) {
    if (userId && r.user_id === userId) own.push(r);
    else if (r.user_id == null) global.push(r);
    else own.push(r); // other-user facts ranked alongside own; rare in practice
  }
  return [...own, ...global];
}

/**
 * tool_lookup_user_facts — Ask AI tool executor.
 *
 * Input from AI: { topic }
 * Ctx from request (3rd arg, server-side only): { user_id, app }
 * Output: { topic, count, facts: [{ id, topic, fact, scope, app, updated_at }] }
 *
 * user_id is INTENTIONALLY not exposed to the AI as a tool parameter —
 * one operator must not be able to coax the AI into reading another
 * operator's facts. The request handler injects user_id from
 * sessionStorage.plm_user; the AI only supplies `topic`.
 *
 * Returns at most MAX_RESULTS. Caller-side trimming on `fact`
 * keeps a single chatty fact from blowing the prompt budget.
 */
export async function tool_lookup_user_facts(db, input, ctx = {}) {
  const topic = clampString(input?.topic, MAX_TOPIC_LEN).trim();
  if (!topic) return { error: "lookup_user_facts requires a non-empty topic." };

  const app = ctx?.app ? clampString(ctx.app, 40).trim() : null;
  const userId = ctx?.user_id ? clampString(ctx.user_id, 80).trim() : null;

  // Pull a generous candidate set keyed on topic, then filter in JS so
  // the per-user vs global ranking + substring match are explicit.
  // Substring search in Postgres via ilike — wraps the query in %.
  const ilikeNeedle = `%${topic.replace(/[%_]/g, "\\$&")}%`;
  let q = db
    .from("ip_ai_user_facts")
    .select("id, user_id, app, topic, fact, updated_at")
    .ilike("topic", ilikeNeedle)
    .order("updated_at", { ascending: false })
    .limit(MAX_RESULTS * 4);

  const { data, error } = await q;
  if (error) return { error: `ip_ai_user_facts read failed: ${error.message || error}` };

  // App filter: keep rows where app matches OR row.app is null (global app).
  const appFiltered = (data || []).filter(r => !app || !r.app || r.app === app);

  // Defensive secondary match (DB ilike + ascii folding edge cases).
  const matched = appFiltered.filter(r => matchTopic(r.topic, topic));

  const ranked = rankFacts(matched, userId).slice(0, MAX_RESULTS);

  return {
    topic,
    count: ranked.length,
    facts: ranked.map(r => ({
      id:         r.id,
      topic:      r.topic,
      fact:       clampString(r.fact, MAX_FACT_LEN),
      scope:      r.user_id ? (r.user_id === userId ? "you"  : "other") : "global",
      app:        r.app || null,
      updated_at: r.updated_at,
    })),
  };
}
