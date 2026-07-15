// api/ai/ask-grid
//
// POST — natural-language Q&A for the ATS grid + other internal apps.
// Thin entry handler: request validation, auth, budget, cache lookup,
// then dispatches to either the streaming SSE path or the non-streaming
// JSON tool-use loop.
//
// All real logic lives in api/_lib/ai/:
//   - constants.js     model + token + iter caps + terminal/tool labels
//   - system-prompt.js the operator-facing SYSTEM_PROMPT (edit here for prose)
//   - tool-defs.js     TOOLS array sent to Claude on every call
//   - executors.js     applyFilter + every tool_* function + TOOL_EXECUTORS
//   - utils.js         pure helpers (date clamp, sanitizeHistory, etc.)
//   - streaming.js     runStreaming SSE variant
//   - schema.js        curated table/column registry + PII flags
//   - live-schema.js   live DB introspection via get_ai_readable_schema()
//   - answer-cache.js  ip_ai_answer_cache read/write helpers
//   - budget.js        assertWithinBudget + logAICall (existing shared helper)
//
// Auth: no bearer header — internal staff live in sessionStorage.plm_user
// (not Supabase Auth). Guards are same-origin + budget cap.
//
// Request body:  { question, history?, grid_context }
// Response:      { text, actions, suggestion?, trace?, token_usage, cached? }

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

import {
  assertWithinBudget,
  BudgetExceededError,
  estimateClaudeCost,
  logAICall,
} from "../../_lib/ai/budget.js";
import {
  modelForApp,
  maxTokensForApp,
  maxIterationsForApp,
  MAX_QUESTION_LEN,
  HANDLER,
  TERMINAL_TOOLS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
  SUPPORTED_IMAGE_MEDIA_TYPES,
} from "../../_lib/ai/constants.js";
import { SYSTEM_PROMPT } from "../../_lib/ai/system-prompt.js";
import { TOOLS } from "../../_lib/ai/tool-defs.js";
import { TOOL_EXECUTORS } from "../../_lib/ai/executors.js";
import { runStreaming } from "../../_lib/ai/streaming.js";
import {
  sanitizeHistory,
  buildGridContextBlock,
  buildScreenContextBlock,
  sanitizeScreenContext,
  summarizeToolResult,
  formatCacheAge,
  sanitizeFollowups,
} from "../../_lib/ai/utils.js";
import {
  buildCacheKey,
  readAnswerCache,
  writeAnswerCache,
} from "../../_lib/ai/answer-cache.js";

export const config = { maxDuration: 60 };

/**
 * Same-origin / allowlist decision for the AI endpoint (anti-CSRF). Pure +
 * exported so it can be unit-tested. Returns true when the caller's
 * Origin/Referer either matches the request's OWN host (true same-origin, so
 * this works on any domain the app is served from — the custom domain, preview
 * URLs, localhost — without hardcoding) or is in the explicit allowlist.
 * Origin comparison is exact (parsed URL origin), which defeats the
 * subdomain-suffix trick `https://apps.ringoffire.com.attacker.com`.
 *
 * @param {{origin?:string, referer?:string, host?:string, allowedOrigins?:string[]}} p
 */
export function isAllowedAiOrigin({ origin = "", referer = "", host = "", allowedOrigins = [] } = {}) {
  const allow = new Set(allowedOrigins);
  const selfHost = String(host || "").trim();
  if (selfHost) { allow.add(`https://${selfHost}`); allow.add(`http://${selfHost}`); }
  let refererOrigin = "";
  try { if (referer) refererOrigin = new URL(referer).origin; } catch { refererOrigin = ""; }
  const fromOrigin  = origin        && allow.has(origin);
  const fromReferer = refererOrigin && allow.has(refererOrigin);
  return Boolean(fromOrigin || fromReferer);
}

const DEFAULT_AI_ORIGINS = "https://apps.ringoffire.com,https://design-calendar-app.vercel.app,http://localhost:5173,http://localhost:3000";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SB_URL        = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });

  // Same-origin guard (anti-CSRF). The request must come from a page served by
  // THIS deployment — see isAllowedAiOrigin. Accepts true same-origin (any host
  // the app runs on, incl. the custom domain apps.ringoffire.com) OR an entry
  // in ALLOWED_AI_ORIGINS. The previous default listed only the vercel.app
  // domain, so every Ask AI call from the custom domain was 403'd in prod.
  const allowedOrigins = (process.env.ALLOWED_AI_ORIGINS || DEFAULT_AI_ORIGINS)
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!isAllowedAiOrigin({
    origin:  req.headers?.origin  || "",
    referer: req.headers?.referer || "",
    host:    req.headers?.host    || "",
    allowedOrigins,
  })) {
    return res.status(403).json({ error: "Request must come from an allowed origin." });
  }

  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const body = req.body || {};
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return res.status(400).json({ error: "question required" });
  if (question.length > MAX_QUESTION_LEN) {
    return res.status(400).json({ error: `question too long (max ${MAX_QUESTION_LEN} chars)` });
  }
  const gridContext = body.grid_context && typeof body.grid_context === "object" ? body.grid_context : {};
  const history     = sanitizeHistory(body.history);

  // Per-request execution context — threaded into tool executors as the
  // 3rd argument. Only `lookup_user_facts` reads it today; future
  // executors that need to know the operator/app can opt in the same
  // way. user_id intentionally NOT exposed as a tool parameter so the
  // AI can't be coerced into reading another operator's facts.
  const execCtx = {
    user_id: typeof body.user_id === "string" ? body.user_id.trim().slice(0, 80) || null : null,
    app:     typeof body.app_id  === "string" ? body.app_id.trim().slice(0, 40)  || null : null,
  };
  // Per-app model (Tangerine → Opus, others → Haiku). Resolved once here and
  // threaded through the streaming + non-streaming paths + cost logging.
  const model = modelForApp(execCtx.app);
  const maxTokens = maxTokensForApp(execCtx.app);
  const maxIterations = maxIterationsForApp(execCtx.app);

  try {
    await assertWithinBudget(db);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return res.status(402).json({
        error: "monthly_ai_budget_exceeded",
        spent_usd:  err.spentUsd,
        budget_usd: err.budgetUsd,
      });
    }
    return res.status(500).json({ error: err.message });
  }

  // Vision attachments (PR 3/4). Validate count + each item's media
  // type + base64 length (decoded bytes ≈ b64Len * 3/4). Reject the
  // whole request on first invalid entry — operator sees a precise
  // error instead of a silent half-included message.
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > MAX_ATTACHMENTS_PER_TURN) {
    return res.status(400).json({ error: `Too many attachments (max ${MAX_ATTACHMENTS_PER_TURN}).` });
  }
  const attachments = [];
  for (const a of rawAttachments) {
    if (!a || typeof a !== "object") continue;
    const mt = String(a.media_type || "");
    const data = String(a.data || "");
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mt)) {
      return res.status(400).json({ error: `Unsupported attachment type '${mt}'.` });
    }
    // Approximate decoded byte size from base64 length (4 chars → 3 bytes,
    // minus padding). Cheap upper-bound check without actually decoding.
    const approxBytes = Math.floor((data.length * 3) / 4);
    if (approxBytes > MAX_ATTACHMENT_BYTES) {
      return res.status(400).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes.` });
    }
    if (!data) {
      return res.status(400).json({ error: "Attachment is empty." });
    }
    attachments.push({ media_type: mt, data });
  }

  const contextBlock = buildGridContextBlock(gridContext);
  // P28-3 companion mode - what the operator is looking at (sanitised;
  // empty string when the host publishes nothing).
  const screenBlock  = buildScreenContextBlock(body.screen_context);
  const textBlock    = `## Current ATS grid context\n${contextBlock}${screenBlock}\n\n## User question\n${question}`;
  // Anthropic multimodal user message: image blocks FIRST so the model
  // sees them as referent to the question that follows. Falls back to
  // a plain string when no attachments — preserves prompt-cache hits
  // for the (much more common) text-only path.
  const userContent = attachments.length === 0
    ? textBlock
    : [
        ...attachments.map(a => ({
          type: "image",
          source: { type: "base64", media_type: a.media_type, data: a.data },
        })),
        { type: "text", text: textBlock },
      ];
  const messages = [
    ...history,
    { role: "user", content: userContent },
  ];

  // Answer cache lookup. Only attempted when there's no prior history
  // (follow-up questions depend on conversation state and aren't safely
  // cacheable from the question alone). Cache key folds in the grid
  // filter fingerprint so the same question against different filters
  // produces different entries.
  // Cache: skip when attachments present (images change per turn and
  // the cache key doesn't hash them) AND when there's prior history.
  const screenForKey = sanitizeScreenContext(body.screen_context);
  const cacheKey = history.length === 0 && attachments.length === 0
    ? buildCacheKey(question, gridContext, screenForKey?.panel_key || "")
    : null;
  if (cacheKey) {
    const hit = await readAnswerCache(db, cacheKey);
    if (hit) {
      const acceptStream = String(req.headers?.accept || "").includes("text/event-stream");
      if (acceptStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        res.write(`event: stage\ndata: ${JSON.stringify({ label: `Cached answer (${formatCacheAge(hit.cached_age_seconds)} ago)` })}\n\n`);
        res.write(`event: text_delta\ndata: ${JSON.stringify({ text: hit.answer_text })}\n\n`);
        res.write(`event: complete\ndata: ${JSON.stringify({
          text: hit.answer_text,
          actions: hit.actions,
          suggestion: hit.suggestion,
          trace: [{ tool: "cache", summary: `served from cache (${formatCacheAge(hit.cached_age_seconds)} ago)` }],
          token_usage: hit.token_usage || { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
          cached: true,
          cached_age_seconds: hit.cached_age_seconds,
        })}\n\n`);
        res.end();
        return;
      }
      return res.status(200).json({
        text: hit.answer_text,
        actions: hit.actions,
        suggestion: hit.suggestion,
        trace: [{ tool: "cache", summary: `served from cache (${formatCacheAge(hit.cached_age_seconds)} ago)` }],
        token_usage: hit.token_usage || { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        cached: true,
        cached_age_seconds: hit.cached_age_seconds,
      });
    }
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const trace = [];

  // Prompt-caching markers. System prompt + tool definitions are
  // identical on every iteration of the loop AND across requests, so
  // marking the last system block + last tool as cache_control hints
  // Anthropic to cache up to (and including) those segments.
  const SYSTEM_CACHED = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ];
  const TOOLS_CACHED = TOOLS.map((t, i) =>
    i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
  );

  // Streaming dispatch — when the client says Accept: text/event-stream,
  // hand off to runStreaming. Operators see live stage labels + token-
  // by-token answer. Non-streaming JSON path kept for non-browser callers.
  const accept = String(req.headers?.accept || "");
  if (accept.includes("text/event-stream")) {
    return runStreaming(req, res, {
      client, db, messages, SYSTEM_CACHED, TOOLS_CACHED, trace,
      cacheKey, question, execCtx, model,
    });
  }

  // ── Non-streaming tool-use loop ───────────────────────────────────────
  let totalIn  = 0;
  let totalOut = 0;
  let totalCost = 0;
  let finalMessage = null;

  for (let iter = 0; iter < maxIterations; iter++) {
    let resp;
    try {
      resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_CACHED,
        tools: TOOLS_CACHED,
        messages,
      });
    } catch (err) {
      await logAICall(db, { handler: HANDLER, model, cost_usd: totalCost, error: err.message });
      return res.status(502).json({ error: `Claude API error: ${err.message}`, trace });
    }

    totalIn  += resp.usage?.input_tokens  ?? 0;
    totalOut += resp.usage?.output_tokens ?? 0;
    totalCost += estimateClaudeCost(resp);
    finalMessage = resp;

    const toolUses = (resp.content || []).filter(b => b.type === "tool_use");
    if (toolUses.length === 0) break;
    const hasNonTerminal = toolUses.some(t => !TERMINAL_TOOLS.has(t.name));
    if (!hasNonTerminal) break;

    // Run non-terminal (DB query) tools in PARALLEL. Terminal tools
    // need an empty ack block so the assistant turn validates.
    const toolResults = await Promise.all(toolUses.map(async (tu) => {
      if (TERMINAL_TOOLS.has(tu.name)) {
        return { type: "tool_result", tool_use_id: tu.id, content: "ok" };
      }
      const exec = TOOL_EXECUTORS[tu.name];
      let result;
      try {
        result = exec
          ? await exec(db, tu.input || {}, execCtx)
          : { error: `Unknown tool: ${tu.name}` };
      } catch (err) {
        result = { error: String(err?.message || err) };
      }
      trace.push({ tool: tu.name, summary: summarizeToolResult(tu.name, result) });
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result).slice(0, 16000),
      };
    }));

    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user",      content: toolResults });
  }

  // Extract terminal blocks from the last assistant turn.
  let text = "";
  const actions   = [];
  let suggestion  = null;
  let followups   = null;
  for (const block of (finalMessage?.content || [])) {
    if (block.type === "tool_use") {
      if (block.name === "answer_text") {
        text = String(block.input?.text || "").trim();
      } else if (block.name === "suggest_grid_view") {
        suggestion = {
          label: String(block.input?.label || "Apply to grid"),
          filters: block.input?.filters || {},
        };
      } else if (block.name === "suggest_followups") {
        followups = sanitizeFollowups(block.input?.questions);
      } else if (TERMINAL_TOOLS.has(block.name)) {
        actions.push({ type: block.name, params: block.input || {} });
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (t) text = text ? `${text}\n\n${t}` : t;
    }
  }

  await logAICall(db, {
    handler: HANDLER,
    model,
    input_tokens:  totalIn,
    output_tokens: totalOut,
    cost_usd: totalCost,
  });

  if (cacheKey && text) {
    await writeAnswerCache(db, {
      hash: cacheKey,
      question,
      answer_text: text,
      actions,
      suggestion,
      token_usage: { input_tokens: totalIn, output_tokens: totalOut, cost_usd: totalCost },
    });
  }

  return res.status(200).json({
    text,
    actions,
    suggestion,
    followups,
    trace,
    token_usage: {
      input_tokens:  totalIn,
      output_tokens: totalOut,
      cost_usd:      totalCost,
    },
  });
}
