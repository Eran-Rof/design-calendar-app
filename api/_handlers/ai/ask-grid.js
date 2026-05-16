// api/ai/ask-grid
//
// POST — answer a natural-language question about the ATS grid, optionally
// returning a structured action (filter / sort / search) the client applies
// to the live grid.
//
// Request body:
//   {
//     question: string,
//     history?: Array<{ role: "user" | "assistant", text: string }>,
//     grid_context: {
//       columns: string[],
//       active_filters: {
//         search?: string,
//         category?: string[],
//         sub_category?: string[],
//         style?: string[],
//         gender?: string,
//         status?: string,
//         min_ats?: number | null,
//         store?: string[],
//         customer?: string,
//       },
//       sort?: { col: string, dir: "asc" | "desc" } | null,
//       row_count: number,
//       totals?: {
//         total_on_hand?: number,
//         total_on_po?: number,
//         total_on_order?: number,
//         total_so_value?: number,
//         total_po_value?: number,
//         margin_pct?: number,
//       },
//       distinct: {
//         categories: string[],
//         sub_categories: string[],
//         styles: string[],
//         genders: string[],
//         stores: string[],
//       },
//       sample_rows?: Array<Record<string, unknown>>,
//     }
//   }
//
// Response: { text: string, actions: Array<{ type, params }>, token_usage }
//
// Auth: matches the existing internal-handler convention — relies on
// authenticateInternalCaller (soft when INTERNAL_API_TOKEN unset).
//
// Budget: gated through assertWithinBudget so the grid Q&A button can't
// outspend AI_MONTHLY_BUDGET_USD. Uses claude-haiku for cost+latency.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../_lib/auth.js";
import {
  assertWithinBudget,
  estimateClaudeCost,
  logAICall,
  BudgetExceededError,
} from "../../_lib/ai-budget.js";

export const config = { maxDuration: 60 };

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1024;
const HANDLER = "ai/ask-grid";

// Cap inputs so a runaway client can't blow up the prompt — Claude bills
// per token and grids can have thousands of rows / hundreds of distinct
// categories. These ceilings are large enough for honest use and small
// enough to keep cost predictable.
const MAX_QUESTION_LEN  = 1000;
const MAX_HISTORY_TURNS = 8;
const MAX_SAMPLE_ROWS   = 20;
const MAX_DISTINCT_VALS = 200;

const TOOLS = [
  {
    name: "apply_filters",
    description:
      "Set one or more filter values on the grid. Any field omitted is left unchanged. Pass an empty array to clear a multi-select filter (category/sub_category/style/store). Pass 'All' for single-select filters (gender/status) to reset them.",
    input_schema: {
      type: "object",
      properties: {
        search:       { type: "string",  description: "Free-text token search across sku + description." },
        category:     { type: "array",   items: { type: "string" }, description: "Set of categories to keep (matches master_category). Empty array = no filter." },
        sub_category: { type: "array",   items: { type: "string" }, description: "Set of sub categories to keep (matches master_sub_category)." },
        style:        { type: "array",   items: { type: "string" }, description: "Set of styles to keep (matches master_style)." },
        gender:       { type: "string",  description: "Single gender to keep, or 'All' to reset." },
        status:       { type: "string",  description: "Single status (e.g. Active, Discontinued) or 'All'." },
        min_ats:      { type: ["number", "null"], description: "Minimum available-to-sell qty. null clears the filter." },
        store:        { type: "array",   items: { type: "string" }, description: "Set of stores to keep (e.g. ['ROF','PT']). ['All'] = no filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_sort",
    description: "Sort the grid by a specific column.",
    input_schema: {
      type: "object",
      properties: {
        col: { type: "string", description: "Column key to sort by. Common keys: sku, description, master_style, master_category, onHand, onPO, onOrder, avgCost, totalAmount." },
        dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction." },
      },
      required: ["col", "dir"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_filters",
    description: "Reset all filters back to defaults (no search, no category, no style, all stores, no min ATS).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "answer_text",
    description: "Reply to the user without changing the grid. Use this for read-only questions like 'what's the total on-order value?' or 'which style has the highest margin?'.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Plain-text answer to display to the user." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const SYSTEM_PROMPT = `You are an analyst assistant embedded in the Ring of Fire ATS (Available-to-Sell) grid. The user is an internal operator browsing inventory, open POs, and open SOs.

Your job: read the user's question, look at the supplied grid context, and respond by calling exactly ONE tool.

Rules:
- If the user wants to narrow the grid ("show me only Mens", "filter to category Tops", "search for PPK", "sort by margin descending", "only show styles with on-order"), call apply_filters or set_sort with the right values pulled from the distinct value lists.
- If the user wants the grid reset ("clear filters", "show everything"), call clear_filters.
- If the user is asking a read-only question about the data ("what's the total on-order value?", "what category has the most SKUs?", "summarize this view"), call answer_text with a concise answer based on the totals + sample rows. Don't make up numbers — if the data isn't in the context, say so.
- Never call more than one tool per turn.
- Filter values are case-sensitive — copy them exactly from the distinct value lists. If the user's phrasing doesn't match exactly, pick the closest match and mention which value you chose.
- Keep answer_text replies under 3 sentences unless the user explicitly asks for detail.`;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-MAX_HISTORY_TURNS)
    .filter(h => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text.length > 0)
    .map(h => ({ role: h.role, content: h.text.slice(0, 2000) }));
}

function clampDistinct(arr) {
  if (!Array.isArray(arr)) return [];
  const filtered = arr.filter(v => typeof v === "string" && v.length > 0);
  if (filtered.length <= MAX_DISTINCT_VALS) return filtered;
  return [...filtered.slice(0, MAX_DISTINCT_VALS), `…(+${filtered.length - MAX_DISTINCT_VALS} more)`];
}

function buildGridContextBlock(ctx) {
  const distinct = ctx.distinct || {};
  const totals   = ctx.totals   || {};
  const filters  = ctx.active_filters || {};
  const sample   = Array.isArray(ctx.sample_rows) ? ctx.sample_rows.slice(0, MAX_SAMPLE_ROWS) : [];

  const lines = [];
  lines.push(`Visible rows: ${ctx.row_count ?? "unknown"}`);
  lines.push(`Columns: ${Array.isArray(ctx.columns) ? ctx.columns.join(", ") : "(unknown)"}`);
  lines.push("");
  lines.push("Active filters:");
  lines.push(JSON.stringify(filters, null, 2));
  if (ctx.sort) {
    lines.push("");
    lines.push(`Sort: ${ctx.sort.col} ${ctx.sort.dir}`);
  }
  lines.push("");
  lines.push("Totals (across the visible rows):");
  lines.push(JSON.stringify(totals, null, 2));
  lines.push("");
  lines.push("Distinct filterable values:");
  lines.push(JSON.stringify({
    categories:     clampDistinct(distinct.categories),
    sub_categories: clampDistinct(distinct.sub_categories),
    styles:         clampDistinct(distinct.styles),
    genders:        clampDistinct(distinct.genders),
    stores:         clampDistinct(distinct.stores),
  }, null, 2));
  if (sample.length > 0) {
    lines.push("");
    lines.push(`Sample rows (first ${sample.length}):`);
    lines.push(JSON.stringify(sample, null, 2));
  }
  return lines.join("\n");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SB_URL        = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });

  const body = req.body || {};
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return res.status(400).json({ error: "question required" });
  if (question.length > MAX_QUESTION_LEN) {
    return res.status(400).json({ error: `question too long (max ${MAX_QUESTION_LEN} chars)` });
  }
  const gridContext = body.grid_context && typeof body.grid_context === "object" ? body.grid_context : {};
  const history     = sanitizeHistory(body.history);

  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

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

  const contextBlock = buildGridContextBlock(gridContext);
  const userMessage  = `## Current ATS grid context\n${contextBlock}\n\n## User question\n${question}`;
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  let message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "any" },
      messages,
    });
  } catch (err) {
    await logAICall(db, {
      handler: HANDLER,
      model: MODEL,
      cost_usd: 0,
      error: err.message,
    });
    return res.status(502).json({ error: `Claude API error: ${err.message}` });
  }

  const costUsd = estimateClaudeCost(message);
  const actions = [];
  let text = "";
  for (const block of message.content || []) {
    if (block.type === "tool_use") {
      if (block.name === "answer_text") {
        text = String(block.input?.text || "").trim();
      } else {
        actions.push({ type: block.name, params: block.input || {} });
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      // Anthropic may still emit free text alongside a tool call; surface
      // it so the operator sees the "I chose category X because…" prose.
      const t = block.text.trim();
      if (t) text = text ? `${text}\n\n${t}` : t;
    }
  }

  await logAICall(db, {
    handler: HANDLER,
    model: MODEL,
    input_tokens:  message.usage?.input_tokens  ?? null,
    output_tokens: message.usage?.output_tokens ?? null,
    cost_usd: costUsd,
  });

  return res.status(200).json({
    text,
    actions,
    token_usage: {
      input_tokens:  message.usage?.input_tokens  ?? null,
      output_tokens: message.usage?.output_tokens ?? null,
      cost_usd:      costUsd,
    },
  });
}
