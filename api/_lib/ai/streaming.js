// Server-Sent Events streaming variant of the Ask AI handler.
//
// Client opts in via `Accept: text/event-stream`. Events emitted:
//   stage     {label}      friendly description of the current step
//                          (e.g. "Searching customers…", "Querying
//                          shipments…")
//   text_delta {text}      incremental chunks of the final answer as
//                          Claude generates it
//   complete  {text, ...}  terminal payload (same shape as the
//                          non-streaming JSON response)
//   error     {error}      terminal error
//
// Operator perception of latency drops massively even when total wall
// time is unchanged — they see what the AI is doing instead of staring
// at "Thinking…".

import {
  MODEL,
  maxTokensForApp,
  maxIterationsForApp,
  HANDLER,
  TERMINAL_TOOLS,
  TOOL_LABELS,
} from "./constants.js";
import { estimateClaudeCost, logAICall } from "./budget.js";
import { TOOL_EXECUTORS } from "./executors.js";
import { writeAnswerCache } from "./answer-cache.js";
import { sseWrite, summarizeToolResult, sanitizeFollowups } from "./utils.js";

// Pull the `text` field out of partial JSON as it grows. Anthropic
// emits the tool's input as input_json_delta events; we accumulate
// and extract the answer_text "text" string incrementally so the panel
// can render token by token without waiting for the full JSON to close.
function extractAnswerTextFromPartialJson(json) {
  const m = /"text"\s*:\s*"((?:\\.|[^"\\])*)/.exec(json);
  if (!m) return "";
  let s = m[1];
  // Strip a trailing incomplete escape sequence (e.g. ends in `\`).
  if (s.endsWith("\\")) s = s.slice(0, -1);
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\t/g, "\t");
}

export async function runStreaming(req, res, opts) {
  const {
    client, db, messages, SYSTEM_CACHED, TOOLS_CACHED, trace,
    cacheKey, question, execCtx,
  } = opts;
  // Per-app model resolved by the handler; fall back to the default if absent.
  const model = opts.model || MODEL;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Abort upstream Anthropic call if the client disconnects mid-stream.
  // Without this, closing the panel kept the function (and its tool
  // calls + budget consumption) running until the maxDuration ceiling.
  const ac = new AbortController();
  let clientGone = false;
  req.on?.("close", () => { clientGone = true; ac.abort(); });

  let totalIn  = 0;
  let totalOut = 0;
  let totalCost = 0;
  let finalContent = [];
  let pendingAnswerText = "";
  let lastEmittedAnswerText = "";

  try {
    const maxTokens = maxTokensForApp(execCtx?.app);
    const maxIterations = maxIterationsForApp(execCtx?.app);
    for (let iter = 0; iter < maxIterations; iter++) {
      if (clientGone) return;
      sseWrite(res, "stage", { label: iter === 0 ? "Thinking…" : "Continuing…" });

      const stream = await client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_CACHED,
        tools: TOOLS_CACHED,
        messages,
      }, { signal: ac.signal });

      pendingAnswerText = "";
      lastEmittedAnswerText = "";
      let activeBlockIsAnswerText = false;

      for await (const event of stream) {
        if (clientGone) return;
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "tool_use") {
            activeBlockIsAnswerText = block.name === "answer_text";
            const friendly = TOOL_LABELS[block.name];
            if (friendly && !TERMINAL_TOOLS.has(block.name)) {
              sseWrite(res, "stage", { label: friendly });
            }
          } else {
            activeBlockIsAnswerText = false;
          }
        } else if (event.type === "content_block_delta") {
          const d = event.delta;
          if (d?.type === "input_json_delta" && activeBlockIsAnswerText) {
            pendingAnswerText += d.partial_json || "";
            const extracted = extractAnswerTextFromPartialJson(pendingAnswerText);
            if (extracted.length > lastEmittedAnswerText.length) {
              const newPart = extracted.slice(lastEmittedAnswerText.length);
              lastEmittedAnswerText = extracted;
              sseWrite(res, "text_delta", { text: newPart });
            }
          }
          // Free `text_delta` blocks (Claude's pre-tool preamble like
          // "Let me look that up…") are intentionally NOT streamed —
          // they leaked before the real answer_text in multi-tool
          // conversations and corrupted the final bubble.
        } else if (event.type === "content_block_stop") {
          activeBlockIsAnswerText = false;
        }
      }

      const finalMessage = await stream.finalMessage();
      totalIn  += finalMessage.usage?.input_tokens  ?? 0;
      totalOut += finalMessage.usage?.output_tokens ?? 0;
      totalCost += estimateClaudeCost(finalMessage);
      finalContent = finalMessage.content || [];

      const toolUses = finalContent.filter(b => b.type === "tool_use");
      if (toolUses.length === 0) break;
      const hasNonTerminal = toolUses.some(t => !TERMINAL_TOOLS.has(t.name));
      if (!hasNonTerminal) break;

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

      messages.push({ role: "assistant", content: finalContent });
      messages.push({ role: "user",      content: toolResults });
    }

    // Extract terminal blocks from finalContent.
    let text = "";
    const actions   = [];
    let suggestion  = null;
    let followups   = null;
    for (const block of finalContent) {
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
      handler: HANDLER, model,
      input_tokens: totalIn, output_tokens: totalOut, cost_usd: totalCost,
    });

    // Cache write — only when no grid mutations + non-empty answer.
    // Fire-and-forget: don't delay the complete event for the write.
    if (cacheKey && text) {
      writeAnswerCache(db, {
        hash: cacheKey,
        question,
        answer_text: text,
        actions,
        suggestion,
        followups,
        token_usage: { input_tokens: totalIn, output_tokens: totalOut, cost_usd: totalCost },
      }).catch(() => { /* warn already logged inside the helper */ });
    }

    sseWrite(res, "complete", {
      text, actions, suggestion, followups, trace,
      token_usage: { input_tokens: totalIn, output_tokens: totalOut, cost_usd: totalCost },
    });
    res.end();
  } catch (err) {
    await logAICall(db, { handler: HANDLER, model, cost_usd: totalCost, error: err.message });
    sseWrite(res, "error", { error: `Claude API error: ${err.message}`, trace });
    res.end();
  }
}
