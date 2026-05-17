// api/internal/design/trend-brief/synthesize
//
// POST — synthesize a monthly trend brief from raw scraped sources.
//   Body: {
//     brief_month: 'YYYY-MM-01',     // first of month (required)
//     sources: {                      // raw dumps from fetch_trend_sources.py
//       pinterest_trends?: {...},
//       reddit_streetwear?: [...],
//       vogue_rss?: [...],
//       ...
//     },
//     persist?: boolean               // default true; false = preview, no DB write
//   }
//   Response: { brief_id, brief_month, status, title, summary_md, themes, token_usage }
//
// Auth: bearer token via authenticateDesignCalendarCaller.
//
// Stage 2 of the AI apparel design pipeline. Budget-guarded via
// api/_lib/ai-budget.js — refuses with 402 once monthly AI spend
// crosses AI_MONTHLY_BUDGET_USD (default $200).
//
// One non-archived brief per month is enforced by a unique partial
// index on ip_trend_briefs. If a brief already exists for the month
// and isn't archived, this handler updates it in place (overwriting
// status='draft', leaving 'published' alone unless force=true).

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { authenticateDesignCalendarCaller } from "../../../../_lib/auth.js";
import {
  assertWithinBudget,
  estimateClaudeCost,
  logAICall,
  BudgetExceededError,
} from "../../../../_lib/ai/budget.js";

export const config = { maxDuration: 60 };

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;
const HANDLER = "design/trend-brief/synthesize";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SB_URL        = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });

  const { brief_month, sources, persist = true, force = false } = req.body ?? {};
  if (!brief_month || !/^\d{4}-\d{2}-01$/.test(brief_month)) {
    return res.status(400).json({ error: "brief_month required, must be YYYY-MM-01" });
  }
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    return res.status(400).json({ error: "sources required (object keyed by source name)" });
  }
  const sourceKeys = Object.keys(sources);
  if (sourceKeys.length === 0) {
    return res.status(400).json({ error: "sources is empty" });
  }

  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── Budget gate ─────────────────────────────────────────────────────────
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

  // ── Look up existing brief for the month ────────────────────────────────
  const { data: existingBriefs, error: existErr } = await db
    .from("ip_trend_briefs")
    .select("id, status")
    .eq("brief_month", brief_month)
    .neq("status", "archived");
  if (existErr) return res.status(500).json({ error: `lookup failed: ${existErr.message}` });

  const existing = (existingBriefs || [])[0] || null;
  if (existing && existing.status === "published" && !force) {
    return res.status(409).json({
      error: "brief_already_published",
      brief_id: existing.id,
      hint: "pass force:true to re-synthesize a published brief (will overwrite)",
    });
  }

  // ── Build prompt ────────────────────────────────────────────────────────
  const prompt = buildPrompt({ brief_month, sources });

  // ── Call Claude ─────────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  let message;
  let costUsd = 0;
  let logErr = null;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
    costUsd = estimateClaudeCost(message);
  } catch (err) {
    logErr = err.message;
    await logAICall(db, {
      handler: HANDLER,
      model: MODEL,
      cost_usd: 0,
      related_table: "ip_trend_briefs",
      related_id: existing?.id || null,
      error: logErr,
    });
    return res.status(502).json({ error: `Claude API error: ${err.message}` });
  }

  // ── Parse response ──────────────────────────────────────────────────────
  const rawText = message.content[0]?.text || "";
  let parsed;
  try {
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/(\{[\s\S]*\})/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);
  } catch {
    await logAICall(db, {
      handler: HANDLER,
      model: MODEL,
      input_tokens:  message.usage?.input_tokens  ?? null,
      output_tokens: message.usage?.output_tokens ?? null,
      cost_usd: costUsd,
      related_table: "ip_trend_briefs",
      related_id: existing?.id || null,
      error: "unparseable_json",
    });
    return res.status(502).json({ error: "Claude returned unparseable JSON", raw: rawText.slice(0, 500) });
  }

  const title       = String(parsed.title || `Trend Brief — ${brief_month.slice(0, 7)}`);
  const summary_md  = String(parsed.summary_md || "");
  const themes      = Array.isArray(parsed.themes) ? parsed.themes : [];

  const token_usage = {
    input_tokens:  message.usage?.input_tokens  ?? null,
    output_tokens: message.usage?.output_tokens ?? null,
    cost_usd:      costUsd,
  };

  // ── Persist ─────────────────────────────────────────────────────────────
  let brief = null;
  if (persist) {
    const payload = {
      brief_month,
      status: "draft",
      title,
      summary_md,
      themes_jsonb: themes,
      raw_sources: sources,
      model: MODEL,
      token_usage,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { data, error } = await db
        .from("ip_trend_briefs")
        .update(payload)
        .eq("id", existing.id)
        .select("id, brief_month, status, title, summary_md, themes_jsonb, model, token_usage")
        .single();
      if (error) return res.status(500).json({ error: `update failed: ${error.message}` });
      brief = data;
    } else {
      const { data, error } = await db
        .from("ip_trend_briefs")
        .insert(payload)
        .select("id, brief_month, status, title, summary_md, themes_jsonb, model, token_usage")
        .single();
      if (error) return res.status(500).json({ error: `insert failed: ${error.message}` });
      brief = data;
    }
  }

  await logAICall(db, {
    handler: HANDLER,
    model: MODEL,
    input_tokens:  message.usage?.input_tokens  ?? null,
    output_tokens: message.usage?.output_tokens ?? null,
    cost_usd: costUsd,
    related_table: "ip_trend_briefs",
    related_id: brief?.id || existing?.id || null,
  });

  return res.status(200).json({
    brief_id:    brief?.id || null,
    brief_month,
    status:      brief?.status || (persist ? "draft" : "preview"),
    title,
    summary_md,
    themes,
    token_usage,
    persisted:   persist,
    source_count: sourceKeys.length,
  });
}

// ── Prompt builder ─────────────────────────────────────────────────────────
function buildPrompt({ brief_month, sources }) {
  const monthLabel = new Date(brief_month + "T00:00:00Z").toLocaleString("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
  const sourceBlocks = Object.entries(sources).map(([name, payload]) => {
    const serialized = typeof payload === "string"
      ? payload.slice(0, 8000)
      : JSON.stringify(payload, null, 2).slice(0, 8000);
    return `### Source: ${name}\n\n${serialized}`;
  }).join("\n\n---\n\n");

  return `You are a trend analyst for Ring of Fire Clothing, an action-sports / streetwear brand based in California. The audience is the design team, who will use this brief to inform concepts and palettes for upcoming drops.

## Brief month
${monthLabel} (${brief_month})

## Raw sources
Below are raw dumps from free trend sources for this period. Treat them as primary evidence, not gospel — sources vary in signal quality (Pinterest Trends and Reddit r/streetwear are strongest; RSS is weaker). Cite specific source-derived signals in your summary.

${sourceBlocks}

## Your task
Synthesize a single trend brief covering ${monthLabel}. Return a single JSON object (no prose outside it) with this shape:

{
  "title": "<short headline, ≤80 chars>",
  "summary_md": "<markdown summary, 3–5 paragraphs. Use ## subheads. Lead with the strongest 1–2 themes, then call out emerging signals, then call out fading signals.>",
  "themes": [
    {
      "name": "<theme name, ≤40 chars>",
      "description": "<1–2 sentences>",
      "signals": ["<specific signal 1>", "<specific signal 2>", "..."],
      "sources": ["<source key 1>", "<source key 2>"],
      "confidence": <0.0–1.0 — your judgement of signal strength, lower if only 1 source supports it>,
      "direction": "rising" | "peaking" | "fading"
    }
  ]
}

Rules:
- 4–7 themes. Fewer themes that each have multi-source support beat many weak themes.
- Signals must be specific (e.g. "Y2K low-rise denim resurging on TikTok Shop best-sellers", not "Y2K").
- If a theme is only supported by one source, mark confidence ≤ 0.4 and say so in the description.
- If the sources are too thin to support a brief at all, return themes: [] and explain in summary_md why.
- Tone: analyst-to-designer. Concrete, no hype. The reader has limited time and cares about actionable directional cues, not exhaustive lists.
- Stay focused on apparel/streetwear/action-sports. Ignore beauty, home, and unrelated lifestyle signals even if they appear in the sources.

Return only the JSON object.`;
}
