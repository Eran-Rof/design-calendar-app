// api/_lib/ai-budget.js
//
// AI cost guardrail for the design pipeline. Premortem mitigation #6 —
// the v1 plan capped Fal.ai spend in the dashboard only; nothing in
// code stopped the Anthropic side from running away. This file enforces
// a per-month USD ceiling across every Claude + Fal call the design
// handlers make.
//
// Usage in a handler:
//   import { assertWithinBudget, logAICall, estimateClaudeCost } from "../../../_lib/ai-budget.js";
//
//   const HANDLER = "design/trend-brief/synthesize";
//   await assertWithinBudget(db);                     // throws BudgetExceededError
//   const msg = await client.messages.create({ ... });
//   await logAICall(db, {
//     handler: HANDLER,
//     model:   "claude-sonnet-4-6",
//     input_tokens:  msg.usage.input_tokens,
//     output_tokens: msg.usage.output_tokens,
//     cost_usd:      estimateClaudeCost(msg),
//     related_table: "ip_trend_briefs",
//     related_id:    brief.id,
//   });
//
// The catch-on-call pattern (vs. middleware): handlers fetch context,
// build prompts, and may early-return before any AI call. assertWithinBudget
// is called right before the AI invocation so we don't reject requests
// that wouldn't have spent money anyway.

const DEFAULT_BUDGET_USD = 200;

// Approximate per-million-token pricing (USD). Update when Anthropic
// changes rates — last verified May 2026. Caller may override via
// estimateClaudeCost's `rates` arg if needed.
const MODEL_RATES = {
  "claude-sonnet-4-6":   { input: 3.00,  output: 15.00 },
  "claude-opus-4-7":     { input: 15.00, output: 75.00 },
  "claude-haiku-4-5":    { input: 0.80,  output: 4.00  },
};

export class BudgetExceededError extends Error {
  constructor(spentUsd, budgetUsd) {
    super(`Monthly AI budget exceeded: $${spentUsd.toFixed(2)} >= $${budgetUsd.toFixed(2)}`);
    this.name = "BudgetExceededError";
    this.statusCode = 402;
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
  }
}

// Throws BudgetExceededError if the running month's AI spend is at or
// over the configured ceiling. Reads AI_MONTHLY_BUDGET_USD from env,
// defaults to $200 trial budget. Pass budgetOverride to bypass env.
export async function assertWithinBudget(supabase, { budgetOverride = null } = {}) {
  const budget = budgetOverride != null
    ? Number(budgetOverride)
    : Number(process.env.AI_MONTHLY_BUDGET_USD || DEFAULT_BUDGET_USD);

  // date_trunc('month', now()) is safe to compute client-side because
  // both Vercel and Supabase run UTC.
  const monthStart = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    1,
  )).toISOString();

  const { data, error } = await supabase
    .from("ip_ai_call_log")
    .select("cost_usd")
    .gte("called_at", monthStart);

  if (error) {
    // Don't fail-open on the budget check — if we can't read the log,
    // we can't trust the cap. Re-raise so the handler returns 500
    // rather than silently spending money.
    throw new Error(`ai-budget: failed to read ip_ai_call_log: ${error.message}`);
  }

  const spent = (data || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  if (spent >= budget) throw new BudgetExceededError(spent, budget);
}

// Estimate USD cost from an Anthropic SDK message response. Returns 0
// when the model isn't in MODEL_RATES — caller should pass an explicit
// rate via opts.rates for non-standard models so cost still logs.
export function estimateClaudeCost(message, opts = {}) {
  const model  = message?.model || opts.model;
  const usage  = message?.usage || {};
  const inTok  = Number(usage.input_tokens  || 0);
  const outTok = Number(usage.output_tokens || 0);
  const rates  = opts.rates || MODEL_RATES[model];
  if (!rates) return 0;
  return (inTok / 1_000_000) * rates.input + (outTok / 1_000_000) * rates.output;
}

// Append-only write to ip_ai_call_log. Failures here are swallowed
// with a warn — the caller already paid for the AI call, so failing to
// log shouldn't break the handler. The next budget check will be
// slightly low but self-correct on the following month boundary.
export async function logAICall(supabase, {
  handler,
  model,
  input_tokens  = null,
  output_tokens = null,
  cost_usd      = 0,
  related_table = null,
  related_id    = null,
  error         = null,
}) {
  const { error: insErr } = await supabase
    .from("ip_ai_call_log")
    .insert({
      handler_name:  handler,
      model,
      input_tokens,
      output_tokens,
      cost_usd,
      related_table,
      related_id,
      error,
    });
  if (insErr) {
    console.warn(`[ai-budget] failed to log call (${handler}/${model}): ${insErr.message}`);
  }
}
