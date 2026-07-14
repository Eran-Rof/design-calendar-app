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

/** Pure — exported for tests. The entire model input for a brief. */
export function buildBriefPrompt(aggregate, name, day) {
  const who = name ? ` ${name}` : "";
  return [
    `You are the daily operations assistant for a Ring of Fire operator${who ? ` named${who}` : ""}. Date: ${day}.`,
    "Below is TODAY'S aggregate — the only facts you may cite. Write a morning brief:",
    "- 2 to 4 sentences, plain prose, no markdown headers/tables/emojis.",
    "- Lead with the single most urgent thing (severity action > warn > info, higher counts first).",
    "- Mention at most 4 items total; group the rest as 'and N more'. Use exact counts from the data.",
    "- If a process state is 'error', mention it. If 'partial' is true, add that some counts may be incomplete.",
    "- If there is genuinely nothing waiting, say the queue is clear in one friendly sentence.",
    "- NEVER invent an item, count, or trend that is not in the JSON below.",
    "",
    "AGGREGATE:",
    JSON.stringify(aggregate),
  ].join("\n");
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
  if (!refresh) {
    const { data: hit } = await admin
      .from("assistant_briefs")
      .select("body, created_at, model")
      .eq("user_id", authUserId)
      .eq("brief_date", day)
      .maybeSingle();
    if (hit?.body) {
      return res.status(200).json({ body: hit.body, brief_date: day, cached: true, model: hit.model });
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

  const aggregate = aggregateForModel(payload);
  const name = await resolveDisplayName(admin, authUserId);
  const model = modelForApp("tangerine");

  let body = "";
  let cost = 0;
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await anthropic.messages.create({
      model,
      max_tokens: BRIEF_MAX_TOKENS,
      messages: [{ role: "user", content: buildBriefPrompt(aggregate, name, day) }],
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
