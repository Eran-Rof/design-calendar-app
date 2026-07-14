// Shared constants for the Ask AI handler + its supporting modules.
// One place to tune model, token budgets, iteration caps, terminal-tool
// classification, and friendly stage labels.

// Haiku 4.5 picked for latency. For tool-orchestration questions (which
// is what this endpoint does), Sonnet's stronger reasoning wasn't paying
// for the ~3-5× per-call latency hit operators were complaining about.
// Budget cap still applies; falls back fine if Anthropic changes pricing.
export const MODEL = "claude-haiku-4-5";

// Per-app model override. The Tangerine ERP assistant spans the full
// accounting/inventory schema AND the user guide, where answer quality matters
// more than the latency edge that picked Haiku for the grid apps — so it runs on
// Opus (operator request). Other apps (ats / po_wip / dc) stay on the default.
export const MODEL_BY_APP = { tangerine: "claude-opus-4-8" };
export function modelForApp(app) {
  return (app && MODEL_BY_APP[app]) || MODEL;
}

export const MAX_TOKENS = 1024;

// Cross-app questions can chain list_domains → list_tables →
// describe_table → query_table, sometimes for two different tables in
// one conversation. 10 gives headroom without runaway cost (each
// iteration is one Claude turn; the budget cap is still authoritative).
export const MAX_TOOL_ITERATIONS = 10;

// P28-2 per-app overrides. Tangerine's assistant answers span GL /
// subledgers / the Today aggregate, where a 1,024-token ceiling truncated
// multi-part answers and 10 iterations pinched multi-subledger chains.
// Other apps keep the tight caps that suit their latency profile.
export const MAX_TOKENS_BY_APP = { tangerine: 2048 };
export const MAX_TOOL_ITERATIONS_BY_APP = { tangerine: 14 };
export function maxTokensForApp(app) {
  return (app && MAX_TOKENS_BY_APP[app]) || MAX_TOKENS;
}
export function maxIterationsForApp(app) {
  return (app && MAX_TOOL_ITERATIONS_BY_APP[app]) || MAX_TOOL_ITERATIONS;
}
export const HANDLER = "ai/ask-grid";

// Request-shape ceilings — protect against runaway clients.
export const MAX_QUESTION_LEN  = 1000;
export const MAX_HISTORY_TURNS = 8;
export const MAX_SAMPLE_ROWS   = 8;   // was 20 — trimmed for input-token cost on every turn
export const MAX_DISTINCT_VALS = 200;

// Per-query row caps. Aggregated tools sum/group before returning so
// payloads stay small even when the underlying scan is large.
export const FIND_CUSTOMER_LIMIT = 25;
export const FIND_STYLE_LIMIT    = 50;
export const QUERY_ROW_LIMIT     = 5000;     // hard ceiling on raw row scans
export const QUERY_RESULT_LIMIT  = 50;       // groups returned to Claude

// Vision attachments — keep in sync with src/ai/imageAttachments.ts.
// 5 MB / image, 3 images / turn is enough for a few row screenshots
// + a vendor email screenshot without runaway token cost.
export const MAX_ATTACHMENT_BYTES        = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN    = 3;
export const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

// Tools that don't require a follow-up Claude turn. When the only
// tool calls in a response are terminal, the loop breaks and the
// client receives the result without another round trip.
export const TERMINAL_TOOLS = new Set([
  "apply_filters", "set_sort", "clear_filters",
  "answer_text", "suggest_grid_view", "suggest_followups",
  // P28-2 — navigate the Tangerine shell to a panel. Client-side action;
  // no server round-trip needed after the model emits it.
  "open_panel",
  // P28-4 — show the operator a Confirm card for a drafted write. Terminal;
  // the actual write happens on the separate authenticated confirm endpoint
  // when the operator clicks Confirm (never from this loop).
  "present_confirmation",
]);

// Friendly stage labels for the SSE `stage` event. Mapped from tool
// name; falls back to a generic spinner label when missing.
export const TOOL_LABELS = {
  find_customer:   "Searching customers…",
  find_style:      "Looking up styles…",
  query_shipments: "Querying shipment history…",
  query_open_sos:  "Checking open sales orders…",
  query_open_pos:  "Checking incoming POs…",
  list_domains:    "Scanning available data sources…",
  list_tables:     "Listing tables…",
  describe_table:  "Reading schema…",
  query_table:     "Running database query…",
  style_card:      "Building style snapshot…",
  customer_card:   "Building customer snapshot…",
  lookup_user_facts: "Checking operator notes…",
  query_margin:    "Computing margin…",
  start_workflow:  "Running multi-step workflow…",
  search_user_guide: "Reading the user guide…",
  get_today:       "Checking your Today queue…",
  open_panel:      "Opening the panel…",
  run_action:          "Preparing that action…",
  present_confirmation: "Ready for your confirmation…",
};
