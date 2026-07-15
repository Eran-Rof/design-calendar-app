// api/internal/assistant/brief
//
// P28-2 — the assistant's morning brief for the Today page.
//   GET            → today's cached brief for the caller; generates it on
//                    the first call of the day (one model run/user/day)
//   GET ?refresh=1 → regenerate (e.g. after working through the queue)
//
// The brief is phrased by the Tangerine assistant model from the SAME
// deterministic aggregate the page renders (aggregateForModel) — it can
// only cite facts already on screen. Requires a resolvable user identity:
// briefs are personal (per-user aggregate + per-user cache row).
//
// Fail-soft contract: any model/config problem returns { body: null,
// reason } with HTTP 200 — the Today page just shows its templated
// greeting. The page must never break because the AI is down.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { modelForApp } from "../../../_lib/ai/constants.js";
import { assertWithinBudget, BudgetExceededError, estimateClaudeCost, logAICall } from "../../../_lib/ai/budget.js";
import { buildTodayForUser, resolveDisplayName, aggregateForModel } from "../../../_lib/assistant/context.js";
import { readAuthUserId } from "./today.js";

export const config = { maxDuration: 45 };

const BRIEF_MAX_TOKENS = 500;
const HANDLER = "assistant/brief";

// A cached brief is refreshed once it is older than this many minutes even if
// the to-do SET hasn't changed — so its counts and its "some data is partial"
// caveat don't sit stale all day (a brief written at 2:45 must not still show
// morning numbers at 5 PM). Set-change / process-flip / partial-flip still
// trigger an IMMEDIATE regen (see briefNeedsRefresh); this is the slow-drift
// backstop. Env-overridable; keep it comfortably above a page-load cadence so
// it doesn't regen on every refresh.
const BRIEF_STALE_MINUTES = Number(process.env.ASSISTANT_BRIEF_STALE_MIN) || 60;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Pure — exported for tests. Have any PROCESS STATE flipped since a cached
 * brief was written? Matches by `key` and compares `state` only (ok/running/
 * warn/error). A process present in one set and absent in the other also
 * counts as diverged. Count/detail drift is deliberately ignored — counts
 * change through the day and must NOT trigger constant regenerations; only a
 * state flip (e.g. a Xoro mirror error→ok) makes a cached brief contradict the
 * live process cards, which is what we regenerate for.
 */
export function processStatesDiverged(cachedProcesses, liveProcesses) {
  const cached = Array.isArray(cachedProcesses) ? cachedProcesses : [];
  const live = Array.isArray(liveProcesses) ? liveProcesses : [];
  const cMap = new Map();
  for (const p of cached) if (p && p.key) cMap.set(p.key, p.state ?? null);
  const lMap = new Map();
  for (const p of live) if (p && p.key) lMap.set(p.key, p.state ?? null);
  for (const k of cMap.keys()) if (!lMap.has(k)) return true;
  for (const k of lMap.keys()) if (!cMap.has(k)) return true;
  for (const [k, st] of cMap) if (lMap.get(k) !== st) return true;
  return false;
}

function keySet(items) {
  const s = new Set();
  for (const it of Array.isArray(items) ? items : []) if (it && it.key) s.add(it.key);
  return s;
}

/**
 * Pure — exported for tests. Has a CACHED brief gone stale in ANY way that
 * would make it recommend an item the operator already handled, or miss a new
 * one? Builds on processStatesDiverged. Returns true when:
 *   - a to-do KEY present in cached is gone from live (operator cleared it), or
 *     a to-do key present in live is absent from cached (a new flag appeared);
 *   - the same, for suggestion keys;
 *   - any process STATE flipped (delegates to processStatesDiverged).
 * DELIBERATELY ignores pure count/detail drift on a SURVIVING to-do key — the
 * live cards already show the current number, so a count ticking 4→2 must NOT
 * force a regeneration on every page load. Only the SET of keys changing (a
 * to-do/suggestion appearing or disappearing) or a process state flip is stale.
 */
export function aggregatesDiverged(cached, live) {
  const c = cached && typeof cached === "object" ? cached : {};
  const l = live && typeof live === "object" ? live : {};
  const cTodos = keySet(c.todos);
  const lTodos = keySet(l.todos);
  for (const k of cTodos) if (!lTodos.has(k)) return true;
  for (const k of lTodos) if (!cTodos.has(k)) return true;
  const cSug = keySet(c.suggestions);
  const lSug = keySet(l.suggestions);
  for (const k of cSug) if (!lSug.has(k)) return true;
  for (const k of lSug) if (!cSug.has(k)) return true;
  if (processStatesDiverged(c.processes, l.processes)) return true;
  return false;
}

/**
 * Pure — exported for tests. The progress the operator made between the brief
 * the assistant last wrote (`cached`) and the live aggregate (`live`), matched
 * by to-do `key`:
 *   - completed: to-dos in cached but ABSENT from live — fully cleared, the
 *     "nice work" items the brief may name back.
 *   - appeared:  to-dos in live but absent from cached — new since last brief.
 *   - reduced:   to-do key in both where live.count < cached.count — partial
 *     progress (optional to surface).
 * Tolerant of missing/empty arrays.
 */
export function computeBriefProgress(cached, live) {
  const c = cached && typeof cached === "object" ? cached : {};
  const l = live && typeof live === "object" ? live : {};
  const cTodos = Array.isArray(c.todos) ? c.todos : [];
  const lTodos = Array.isArray(l.todos) ? l.todos : [];
  const cMap = new Map();
  for (const t of cTodos) if (t && t.key) cMap.set(t.key, t);
  const lMap = new Map();
  for (const t of lTodos) if (t && t.key) lMap.set(t.key, t);

  const completed = [];
  for (const [k, t] of cMap) {
    if (!lMap.has(k)) completed.push({ key: k, title: t.title ?? null, count: t.count ?? null });
  }
  const appeared = [];
  for (const [k, t] of lMap) {
    if (!cMap.has(k)) {
      appeared.push({ key: k, title: t.title ?? null, count: t.count ?? null, severity: t.severity ?? null });
    }
  }
  const reduced = [];
  for (const [k, lt] of lMap) {
    const ct = cMap.get(k);
    if (!ct) continue;
    const from = typeof ct.count === "number" ? ct.count : null;
    const to = typeof lt.count === "number" ? lt.count : null;
    if (from != null && to != null && to < from) {
      reduced.push({ key: k, title: lt.title ?? ct.title ?? null, from, to });
    }
  }
  return { completed, appeared, reduced };
}

/**
 * Pure — exported for tests. Should a cached brief be regenerated? True when:
 *   - the to-do / suggestion SET changed or a process state flipped
 *     (aggregatesDiverged — an item was completed, a new one appeared, a card
 *     flipped): the prose is actively wrong → regenerate now; OR
 *   - the `partial` flag flipped (data was incomplete when written and is now
 *     complete, or vice-versa): the "counts may be incomplete" caveat is now
 *     wrong → regenerate; OR
 *   - the brief is older than `staleMinutes`: counts drift through the day, so
 *     refresh even a still-accurate-set brief so it doesn't show morning numbers
 *     all afternoon.
 * Best-effort caller wraps this; on any doubt it returns false (serve cached).
 *
 * @param {object} cachedSource  the cached brief's source_json aggregate
 * @param {object} live          the current aggregateForModel(payload)
 * @param {string|Date} createdAt the cached brief's created_at
 * @param {number} staleMinutes  age threshold
 * @param {Date} now             injectable clock (tests)
 */
export function briefNeedsRefresh(cachedSource, live, createdAt, staleMinutes, now = new Date()) {
  if (aggregatesDiverged(cachedSource, live)) return true;
  const cPartial = Boolean(cachedSource && cachedSource.partial);
  const lPartial = Boolean(live && live.partial);
  if (cPartial !== lPartial) return true;
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  if (Number.isFinite(t)) {
    const ageMin = (now.getTime() - t) / 60000;
    if (ageMin >= staleMinutes) return true;
  }
  return false;
}

/**
 * Pure — exported for tests. The entire model input for a brief. When
 * `progress.completed` is non-empty the brief opens with a brief, genuine
 * acknowledgment of what the operator cleared and closes by inviting the next
 * task — a live, progress-aware companion rather than a static morning dump.
 * The no-fabrication rule still holds: only items in the current aggregate (or
 * named in the progress delta) may be cited.
 */
export function buildBriefPrompt(aggregate, name, day, progress = null) {
  const who = name ? ` ${name}` : "";
  const completed = progress && Array.isArray(progress.completed) ? progress.completed : [];
  const lines = [
    `You are the daily operations assistant for a Ring of Fire operator${who ? ` named${who}` : ""}. Date: ${day}.`,
    "Below is the CURRENT aggregate — the only facts you may cite. Write a warm, current brief:",
    "- 2 to 4 sentences, plain prose, no markdown headers/tables/emojis.",
  ];
  if (completed.length > 0) {
    lines.push(
      "- The operator has made progress since the last brief. The PROGRESS block below lists what they just cleared.",
      "- OPEN with one short, genuine acknowledgment naming what was cleared (e.g. 'You cleared the 4 vendor replies I flagged — nice.'). Vary the phrasing; be encouraging, not saccharine.",
      "- THEN cover the current state, mentioning ONLY items still in the aggregate (anything they cleared is already gone from it).",
      "- END with a short inviting line like 'What do you want to work on next?'.",
    );
  } else {
    lines.push(
      "- This is the first read of the day (no prior progress). Greet normally; a gentle forward-looking close is fine but do not force a 'what next?' if it reads oddly.",
    );
  }
  lines.push(
    "- Lead the state with the single most urgent thing (severity action > warn > info, higher counts first).",
    "- Mention at most 4 items total; group the rest as 'and N more'. Use exact counts from the data.",
    "- If a process state is 'error', mention it. If 'partial' is true, add that some counts may be incomplete.",
    "- If there is genuinely nothing waiting, say the queue is clear in one friendly sentence.",
    "- NEVER invent an item, count, or trend that is not in the AGGREGATE or PROGRESS blocks below. Only name completed items that appear in PROGRESS.completed.",
    "",
    "AGGREGATE:",
    JSON.stringify(aggregate),
  );
  if (completed.length > 0) {
    lines.push("", "PROGRESS:", JSON.stringify({ completed }));
  }
  return lines.join("\n");
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const authUserId = readAuthUserId(req);
  if (!authUserId) return res.status(200).json({ body: null, reason: "no_user" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const refresh = url.searchParams.get("refresh") === "1";

  const h = req.headers || {};
  const entityHint = String(h["x-entity-id"] ?? h["X-Entity-ID"] ?? "").trim() || null;

  // Cache hit — one model run per user per day.
  const { day, payload } = await buildTodayForUser(admin, { authUserId, entityHint });
  // Compute the live model-facing aggregate ONCE — it is both the staleness
  // comparison target and (on regeneration) the new source_json snapshot.
  const currentAggregate = aggregateForModel(payload);
  // Progress the operator made since the assistant last wrote a brief; drives a
  // warm, progress-aware regeneration. Populated only on a stale cache hit.
  let progress = null;
  if (!refresh) {
    const { data: hit } = await admin
      .from("assistant_briefs")
      .select("body, created_at, model, source_json")
      .eq("user_id", authUserId)
      .eq("brief_date", day)
      .maybeSingle();
    if (hit?.body) {
      // Stale-brief guard: the brief snapshots the whole aggregate (to-dos,
      // suggestions, process states) at generation time. If the operator has
      // cleared a to-do the assistant flagged this morning, a new flag has
      // appeared, or a process flipped state, the cached prose now recommends
      // things that are done or contradicts the live cards. Regenerate in that
      // case; otherwise serve cached. Best-effort — any failure here falls back
      // to the cached brief so the staleness check can never break the endpoint.
      let stale = false;
      try {
        stale = briefNeedsRefresh(hit.source_json, currentAggregate, hit.created_at, BRIEF_STALE_MINUTES);
      } catch {
        stale = false;
      }
      if (!stale) {
        return res.status(200).json({ body: hit.body, brief_date: day, cached: true, model: hit.model });
      }
      // Stale → regenerate. Capture what changed vs the last brief so the new
      // prose can acknowledge it. Best-effort — never let the diff break us.
      try {
        progress = computeBriefProgress(hit.source_json, currentAggregate);
      } catch {
        progress = null;
      }
      // else: fall through to the regeneration path (same as ?refresh=1).
    }
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(200).json({ body: null, reason: "no_api_key" });

  try {
    await assertWithinBudget(admin);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return res.status(200).json({ body: null, reason: "budget_exceeded" });
    }
    return res.status(200).json({ body: null, reason: err.message });
  }

  const aggregate = currentAggregate;
  const name = await resolveDisplayName(admin, authUserId);
  const model = modelForApp("tangerine");

  let body = "";
  let cost = 0;
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await anthropic.messages.create({
      model,
      max_tokens: BRIEF_MAX_TOKENS,
      messages: [{ role: "user", content: buildBriefPrompt(aggregate, name, day, progress) }],
    });
    cost = estimateClaudeCost(resp);
    body = (resp.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    await logAICall(admin, {
      handler: HANDLER,
      model,
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
      cost_usd: cost,
    });
  } catch (err) {
    await logAICall(admin, { handler: HANDLER, model, cost_usd: cost, error: String(err?.message || err) });
    return res.status(200).json({ body: null, reason: `model_error: ${String(err?.message || err)}` });
  }
  if (!body) return res.status(200).json({ body: null, reason: "empty_completion" });

  await admin.from("assistant_briefs").upsert(
    { user_id: authUserId, brief_date: day, body, source_json: aggregate, model },
    { onConflict: "user_id,brief_date" },
  );

  return res.status(200).json({ body, brief_date: day, cached: false, model });
}
