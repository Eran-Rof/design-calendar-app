// api/ai/ask-grid
//
// POST — natural-language Q&A for the ATS grid. Claude can call:
//   • Grid-mutation tools (apply_filters / set_sort / clear_filters)
//     — executed immediately by the client on receipt.
//   • Read-only DB query tools (find_customer / find_style /
//     query_shipments / query_open_sos / query_open_pos)
//     — executed server-side; results are looped back to Claude so it
//     can reason across multiple lookups.
//   • Reply tools (answer_text / suggest_grid_view) — terminal.
//
// "Push to grid?" UX: when Claude wants to suggest a follow-up filter
// after answering a cross-table question, it calls suggest_grid_view
// with a label + the same filter shape as apply_filters. The client
// renders a "Push to grid" button next to the AI reply; clicking it
// applies the filter via the existing setter bundle. The user opts in,
// per product requirement (text first, push on confirm).
//
// Request body:
//   {
//     question: string,
//     history?: Array<{ role: "user" | "assistant", text: string }>,
//     grid_context: GridContextSnapshot,   // shape: see src/ai/tools.ts
//   }
//
// Response:
//   {
//     text: string,                        // answer_text content, if any
//     actions: Array<{ type, params }>,    // immediate grid mutations
//     suggestion?: { label: string, filters: ApplyFiltersParams },
//     trace?: Array<{ tool: string, summary: string }>,
//     token_usage: { input_tokens, output_tokens, cost_usd },
//   }

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
// No bearer auth on this endpoint: internal staff in this app live in
// sessionStorage.plm_user (not Supabase Auth), so there's no JWT to send.
// Static INTERNAL_API_TOKEN can't ride in a browser bundle without being
// trivially extractable. Guards instead: same-origin Origin/Referer check
// + the assertWithinBudget ceiling — caps damage at AI_MONTHLY_BUDGET_USD
// (default $200/month) regardless of caller identity.
import {
  assertWithinBudget,
  estimateClaudeCost,
  logAICall,
  BudgetExceededError,
} from "../../_lib/ai-budget.js";
import {
  DOMAINS,
  ALLOWED_FILTER_OPS,
  ALLOWED_AGGS,
  lookupTable,
  publicColumns,
} from "../../_lib/ai-schema.js";

export const config = { maxDuration: 60 };

// Haiku 4.5 picked for latency. For tool-orchestration questions (which
// is what this endpoint does), Sonnet's stronger reasoning wasn't paying
// for the ~3-5× per-call latency hit operators were complaining about.
// Budget cap still applies; falls back fine if Anthropic changes pricing.
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1024;
// Cross-app questions can chain list_domains → list_tables →
// describe_table → query_table, sometimes for two different tables in
// one conversation. 10 gives headroom without runaway cost (each
// iteration is one Claude turn; the budget cap is still authoritative).
const MAX_TOOL_ITERATIONS = 10;
const HANDLER = "ai/ask-grid";

const MAX_QUESTION_LEN  = 1000;
const MAX_HISTORY_TURNS = 8;
const MAX_SAMPLE_ROWS   = 8;   // was 20 — trimmed for input-token cost on every turn
const MAX_DISTINCT_VALS = 200;

// Per-query row caps. Aggregated tools sum/group before returning so
// payloads stay small even when the underlying scan is large.
const FIND_CUSTOMER_LIMIT = 25;
const FIND_STYLE_LIMIT    = 50;
const QUERY_ROW_LIMIT     = 5000;     // hard ceiling on raw row scans
const QUERY_RESULT_LIMIT  = 50;       // groups returned to Claude

const TOOLS = [
  // ── Grid mutations (terminal) ─────────────────────────────────────────
  {
    name: "apply_filters",
    description: "Set one or more filter values on the visible grid. Any field omitted is left unchanged. Pass an empty array to clear a multi-select filter; pass 'All' for single-select. Use this when the user explicitly asks to narrow what's on screen.",
    input_schema: {
      type: "object",
      properties: {
        search:       { type: "string" },
        category:     { type: "array",  items: { type: "string" } },
        sub_category: { type: "array",  items: { type: "string" } },
        style:        { type: "array",  items: { type: "string" } },
        gender:       { type: "string" },
        status:       { type: "string" },
        min_ats:      { type: ["number", "null"] },
        store:        { type: "array",  items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_sort",
    description: "Sort the grid by a column.",
    input_schema: {
      type: "object",
      properties: {
        col: { type: "string" },
        dir: { type: "string", enum: ["asc", "desc"] },
      },
      required: ["col", "dir"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_filters",
    description: "Reset all filters back to defaults.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },

  // ── DB lookups (looped — results fed back to Claude) ─────────────────
  {
    name: "find_customer",
    description: "Resolve a customer name fragment to ip_customer_master rows. Use this first whenever the user names a customer (e.g. 'Ross', 'PacSun') so subsequent queries can pass the right customer_id. Returns id, name, customer_code.",
    input_schema: {
      type: "object",
      properties: {
        name_contains: { type: "string", description: "Substring to search for (case-insensitive)." },
      },
      required: ["name_contains"],
      additionalProperties: false,
    },
  },
  {
    name: "find_style",
    description: "Resolve a style/SKU name fragment to ip_item_master rows. Use this when the user names a product family (e.g. 'Edge', 'Bartram'). Returns distinct style_codes plus a sample of SKUs.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against sku_code, style_code, or description." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "query_shipments",
    description: "Aggregate historical wholesale shipments (ip_sales_history_wholesale) for a customer and/or style/SKU within a date range. Returns rows grouped by style_code with total qty + net_amount. Use this for 'how much did we ship X to Y in period Z' questions.",
    input_schema: {
      type: "object",
      properties: {
        customer_id:  { type: "string",  description: "ip_customer_master.id; preferred when known." },
        style_code:   { type: "string",  description: "ip_item_master.style_code; filters all SKU variants in the family." },
        sku_code:     { type: "string",  description: "ip_item_master.sku_code; exact SKU filter." },
        date_from:    { type: "string",  description: "ISO date YYYY-MM-DD; inclusive lower bound on txn_date." },
        date_to:      { type: "string",  description: "ISO date YYYY-MM-DD; inclusive upper bound on txn_date." },
        txn_type:     { type: "string",  enum: ["order", "ship", "invoice"], description: "Optional filter; default is all types." },
        group_by:     { type: "string",  enum: ["style", "sku", "customer", "month"], description: "Aggregation grain; default 'style'." },
      },
      required: ["date_from", "date_to"],
      additionalProperties: false,
    },
  },
  {
    name: "query_open_sos",
    description: "Aggregate open sales orders (ip_open_sales_orders). Filter by customer, style/SKU, and ship_date range. Returns grouped totals for qty_open / qty_ordered / qty_shipped.",
    input_schema: {
      type: "object",
      properties: {
        customer_id:  { type: "string" },
        style_code:   { type: "string" },
        sku_code:     { type: "string" },
        date_from:    { type: "string", description: "Inclusive lower bound on ship_date." },
        date_to:      { type: "string", description: "Inclusive upper bound on ship_date." },
        group_by:     { type: "string", enum: ["style", "sku", "customer", "month"], description: "Default 'style'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "query_open_pos",
    description: "Aggregate open purchase orders (ip_open_purchase_orders). Filter by vendor (via vendor_id is not exposed — use style/sku), style/SKU, and expected_date range. Returns grouped qty_open / qty_ordered / qty_received.",
    input_schema: {
      type: "object",
      properties: {
        style_code:   { type: "string" },
        sku_code:     { type: "string" },
        date_from:    { type: "string", description: "Inclusive lower bound on expected_date." },
        date_to:      { type: "string", description: "Inclusive upper bound on expected_date." },
        group_by:     { type: "string", enum: ["style", "sku", "month"], description: "Default 'style'." },
      },
      additionalProperties: false,
    },
  },

  // ── Reply tools (terminal) ────────────────────────────────────────────
  {
    name: "answer_text",
    description: "Send a plain-text answer to the user. Use this for any question the user asked. Numbers should be backed by actual tool results — never fabricate.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "suggest_grid_view",
    description: "After answering, propose a grid filter the user can opt into with one click. Use only when the answer is naturally tied to a subset of the grid (e.g. 'Ross-Edge styles' → a filter that narrows the grid to just those styles). Do NOT call this for general questions where no grid view fits.",
    input_schema: {
      type: "object",
      properties: {
        label:   { type: "string", description: "Button label, e.g. 'Show Edge styles in grid'." },
        filters: {
          type: "object",
          description: "Same shape as apply_filters params.",
          properties: {
            search:       { type: "string" },
            category:     { type: "array",  items: { type: "string" } },
            sub_category: { type: "array",  items: { type: "string" } },
            style:        { type: "array",  items: { type: "string" } },
            gender:       { type: "string" },
            status:       { type: "string" },
            min_ats:      { type: ["number", "null"] },
            store:        { type: "array",  items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      required: ["label", "filters"],
      additionalProperties: false,
    },
  },

  // ── Cross-app discovery + generic query (looped) ─────────────────────
  {
    name: "list_domains",
    description: "List the four app domains the AI can query (po_wip, vendor_portal, planning, design_calendar) with a one-line description. Use this first when the user asks a question outside ATS sales/PO/inventory and you're not sure which tables exist.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tables",
    description: "List the readable tables inside a domain (table_name + description). Use this after list_domains when narrowing in on a domain.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "One of: po_wip, vendor_portal, planning, design_calendar." },
      },
      required: ["domain"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_table",
    description: "Return the columns + types + flags (filterable / groupable / aggregatable / date) for a single table so you know what's safe to use as a filter / group_by / aggregation. PII columns are silently excluded.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name, e.g. 'invoices' or 'compliance_documents'." },
        domain: { type: "string", description: "Optional. Provide if the table name is ambiguous." },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
  {
    name: "query_table",
    description: "Run a safe parameterised aggregation against any AI-readable table. Supply filters + optional group_by columns + optional aggregations. Returns up to 50 grouped rows. Use describe_table first if you're unsure which columns are valid.",
    input_schema: {
      type: "object",
      properties: {
        table:  { type: "string", description: "Table name from list_tables." },
        domain: { type: "string", description: "Optional. Use when table name is ambiguous." },
        filters: {
          type: "array",
          description: "List of { col, op, value } filters. op is one of: eq, neq, gt, gte, lt, lte, in, ilike, is_null, not_is_null. For 'in', pass an array of values. For 'is_null' / 'not_is_null', value is ignored.",
          items: {
            type: "object",
            properties: {
              col:   { type: "string" },
              op:    { type: "string", enum: ["eq","neq","gt","gte","lt","lte","in","ilike","is_null","not_is_null"] },
              value: {},
            },
            required: ["col", "op"],
            additionalProperties: false,
          },
        },
        date_range: {
          type: "object",
          description: "Convenience filter on a date column: { col, from?, to? } with YYYY-MM-DD bounds (inclusive).",
          properties: {
            col:  { type: "string" },
            from: { type: "string" },
            to:   { type: "string" },
          },
          required: ["col"],
          additionalProperties: false,
        },
        group_by: {
          type: "array",
          description: "Columns to group by. Up to 3.",
          items: { type: "string" },
        },
        aggregations: {
          type: "array",
          description: "List of { fn, col?, as? }. fn is one of sum, count, avg, min, max. col is required for sum/avg/min/max; ignored for count.",
          items: {
            type: "object",
            properties: {
              fn:  { type: "string", enum: ALLOWED_AGGS },
              col: { type: "string" },
              as:  { type: "string", description: "Optional alias for the output column." },
            },
            required: ["fn"],
            additionalProperties: false,
          },
        },
        order_by: {
          type: "object",
          description: "Optional order. col must be a group_by column or an aggregation alias.",
          properties: {
            col: { type: "string" },
            dir: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["col"],
          additionalProperties: false,
        },
        limit: { type: "integer", description: "Max rows returned (default 50, max 200)." },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
];

const SYSTEM_PROMPT = `You are an analyst assistant embedded in the Ring of Fire ATS (Available-to-Sell) grid for internal operators. You have read-only access to four app domains: ATS (the visible grid), PO WIP, Vendor Portal, Planning, and Design Calendar.

You have three modes:

1. **Grid-state Q&A** — questions answerable from the grid snapshot (active filters, totals, sample rows, distinct values). Call answer_text directly, or apply_filters / set_sort / clear_filters if the user wants the grid changed.

2. **Hot-path cross-table Q&A** (ATS history / open orders / open POs) — for "how many Edge did Ross order June 2026 vs ship same period last year" style questions:
   a. Resolve names → IDs with find_customer / find_style.
   b. Run query_shipments / query_open_sos / query_open_pos with the resolved IDs and a date range.
   c. Answer with answer_text using the actual numbers.
   d. If the answer ties to a grid subset, ALSO call suggest_grid_view.

3. **Cross-app Q&A** (PO WIP / Vendor Portal / Planning / Design Calendar) — for anything not covered by the hot-path tools:
   a. Use list_domains → list_tables → describe_table to find the right table.
   b. Use query_table with filters + group_by + aggregations to get the answer.
   c. Examples: "what compliance docs expire in the next 30 days" → query compliance_documents. "what's our total AR open right now" → query invoices grouped by status. "which vendors had the most disputes this quarter" → query disputes grouped by vendor_id.
   d. Always answer in text. Only call suggest_grid_view if the answer ties to a filter on the ATS grid (rarely the case for cross-app questions).

Rules:
- Tool selection is yours — pick the smallest set that answers the question.
- NEVER make up names, IDs, qty, dollars, or any other data. If a tool returns nothing, say so.
- Date ranges: when the user says "June 2026", use 2026-06-01 → 2026-06-30. "Last year same period" = same month/range one calendar year earlier. "This quarter" = the calendar quarter containing today.
- Today's date is in the grid context — use it for relative phrases.
- When a name resolves to multiple candidates, mention which match you used.
- PII (bank account numbers, encrypted card data, etc.) is silently excluded from every response — you literally cannot see those columns.

Formatting rules for answer_text (the operator sees this in a chat panel):
- Write in clean, professional prose. Default 1–3 short sentences. Up to 5 if the question is genuinely multi-part.
- Use **bold** sparingly — only for the key numeric answer (e.g. **16,701 units**).
- Do NOT use markdown tables, headers (#, ##), code blocks, blockquotes, or horizontal rules — the panel renders bold only.
- Numbers: thousands separators on quantities (16,701 not 16701). Money: $ + thousands separators + cents only if non-zero ($146,134, not $146134.00).
- No emojis. No bullet points unless the user asks to "list" something — then use plain "- " bullets, max 5 items.
- Lead with the answer, then context. Avoid preamble like "Here's the breakdown" or "Based on the data".`;

// ─────────────────────────────────────────────────────────────────────────
// Tool executors — every read tool here MUST be allowlisted, parameterised,
// and read-only. No raw SQL. Errors return a structured payload so Claude
// can recover rather than crashing the loop.
// ─────────────────────────────────────────────────────────────────────────

function canonName(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function clampString(s, max) {
  return String(s || "").slice(0, max);
}

function clampDate(s) {
  // ISO YYYY-MM-DD only — reject anything else so caller can't smuggle
  // PostgREST operators into the parameter.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function tool_find_customer(db, input) {
  const q = clampString(input?.name_contains, 100).trim();
  if (!q) return { error: "name_contains required" };
  const firstWord = q.split(/\s+/)[0] || q;
  const target = canonName(q);

  const { data, error } = await db
    .from("ip_customer_master")
    .select("id, name, customer_code")
    .ilike("name", `${firstWord}%`)
    .limit(FIND_CUSTOMER_LIMIT);
  if (error) return { error: error.message };

  const scored = (data || []).map(r => {
    const c = canonName(r.name);
    const exact = c === target ? 2 : (c.startsWith(target) || target.startsWith(c) ? 1 : 0);
    return { ...r, _score: exact };
  }).sort((a, b) => b._score - a._score);

  return {
    matches: scored.slice(0, FIND_CUSTOMER_LIMIT).map(r => ({
      id: r.id, name: r.name, customer_code: r.customer_code,
    })),
    count: scored.length,
  };
}

async function tool_find_style(db, input) {
  const q = clampString(input?.query, 100).trim();
  if (!q) return { error: "query required" };
  const enc = `%${q}%`;

  // OR across sku_code, style_code, description so a single query
  // catches "Edge" whether it's a style code, SKU prefix, or product
  // name fragment.
  const { data, error } = await db
    .from("ip_item_master")
    .select("sku_code, style_code, description, color, size, active")
    .or(`sku_code.ilike.${enc},style_code.ilike.${enc},description.ilike.${enc}`)
    .eq("active", true)
    .limit(FIND_STYLE_LIMIT * 4);
  if (error) return { error: error.message };

  // Roll up to distinct style_codes (the grain Claude usually wants),
  // then return up to FIND_STYLE_LIMIT plus a sample of SKUs per style.
  const byStyle = new Map();
  for (const r of (data || [])) {
    const key = r.style_code || r.sku_code;
    if (!key) continue;
    if (!byStyle.has(key)) {
      byStyle.set(key, {
        style_code: r.style_code,
        sample_description: r.description || null,
        sku_count: 0,
        sample_skus: [],
      });
    }
    const acc = byStyle.get(key);
    acc.sku_count += 1;
    if (acc.sample_skus.length < 5) acc.sample_skus.push(r.sku_code);
  }
  const styles = Array.from(byStyle.values()).slice(0, FIND_STYLE_LIMIT);
  return { styles, count: byStyle.size };
}

// Resolve style_code / sku_code to a set of ip_item_master.id values
// so the query tools can filter on the FK column (sku_id).
async function resolveSkuIdsForStyleOrSku(db, { style_code, sku_code }) {
  if (!style_code && !sku_code) return null;
  let q = db.from("ip_item_master").select("id, sku_code, style_code").limit(2000);
  if (style_code) q = q.eq("style_code", style_code);
  if (sku_code)   q = q.eq("sku_code", sku_code);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { ids: (data || []).map(r => r.id), rows: data || [] };
}

function monthKey(dateStr) {
  if (!dateStr) return "unknown";
  return String(dateStr).slice(0, 7);
}

async function tool_query_shipments(db, input) {
  const date_from = clampDate(input?.date_from);
  const date_to   = clampDate(input?.date_to);
  if (!date_from || !date_to) return { error: "date_from and date_to required (YYYY-MM-DD)" };

  const skuIdsResolved = await resolveSkuIdsForStyleOrSku(db, input);
  if (skuIdsResolved?.error) return { error: skuIdsResolved.error };
  const skuIds = skuIdsResolved?.ids ?? null;
  if (skuIds && skuIds.length === 0) {
    return { groups: [], note: "No SKUs matched the supplied style_code/sku_code." };
  }

  let q = db
    .from("ip_sales_history_wholesale")
    .select("sku_id, customer_id, txn_date, txn_type, qty, net_amount")
    .gte("txn_date", date_from)
    .lte("txn_date", date_to)
    .limit(QUERY_ROW_LIMIT);
  if (input?.customer_id) q = q.eq("customer_id", input.customer_id);
  if (input?.txn_type)    q = q.eq("txn_type",    input.txn_type);
  if (skuIds)             q = q.in("sku_id", skuIds);

  const { data, error } = await q;
  if (error) return { error: error.message };

  // Need style_code per sku for "group by style". Pull the master
  // rows once for the sku_ids we actually got back.
  const seenSkuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  let skuToStyle = new Map();
  let skuToCode  = new Map();
  if (seenSkuIds.length > 0 && (input?.group_by ?? "style") !== "customer") {
    const { data: masters } = await db
      .from("ip_item_master")
      .select("id, sku_code, style_code")
      .in("id", seenSkuIds);
    for (const m of (masters || [])) {
      if (m.style_code) skuToStyle.set(m.id, m.style_code);
      if (m.sku_code)   skuToCode.set(m.id, m.sku_code);
    }
  }

  const groupBy = input?.group_by ?? "style";
  const groups = new Map();
  for (const r of (data || [])) {
    let key;
    switch (groupBy) {
      case "sku":      key = skuToCode.get(r.sku_id) || r.sku_id; break;
      case "customer": key = r.customer_id || "(no customer)";    break;
      case "month":    key = monthKey(r.txn_date);                break;
      case "style":
      default:         key = skuToStyle.get(r.sku_id) || skuToCode.get(r.sku_id) || "(unmatched)"; break;
    }
    if (!groups.has(key)) groups.set(key, { key, qty: 0, net_amount: 0, row_count: 0 });
    const g = groups.get(key);
    g.qty        += Number(r.qty || 0);
    g.net_amount += Number(r.net_amount || 0);
    g.row_count  += 1;
  }
  const out = Array.from(groups.values()).sort((a, b) => b.qty - a.qty).slice(0, QUERY_RESULT_LIMIT);
  const totalQty = out.reduce((s, g) => s + g.qty, 0);
  const totalAmt = out.reduce((s, g) => s + g.net_amount, 0);
  return {
    groups: out,
    group_count: groups.size,
    row_count: (data || []).length,
    capped: (data || []).length >= QUERY_ROW_LIMIT,
    totals: { qty: totalQty, net_amount: totalAmt },
    group_by: groupBy,
  };
}

async function tool_query_open_sos(db, input) {
  const skuIdsResolved = await resolveSkuIdsForStyleOrSku(db, input);
  if (skuIdsResolved?.error) return { error: skuIdsResolved.error };
  const skuIds = skuIdsResolved?.ids ?? null;
  if (skuIds && skuIds.length === 0) {
    return { groups: [], note: "No SKUs matched the supplied style_code/sku_code." };
  }

  let q = db
    .from("ip_open_sales_orders")
    .select("sku_id, customer_id, customer_name, ship_date, qty_ordered, qty_shipped, qty_open, unit_price")
    .limit(QUERY_ROW_LIMIT);
  if (input?.customer_id) q = q.eq("customer_id", input.customer_id);
  if (skuIds)             q = q.in("sku_id", skuIds);
  if (input?.date_from) {
    const d = clampDate(input.date_from);
    if (!d) return { error: "date_from must be YYYY-MM-DD" };
    q = q.gte("ship_date", d);
  }
  if (input?.date_to) {
    const d = clampDate(input.date_to);
    if (!d) return { error: "date_to must be YYYY-MM-DD" };
    q = q.lte("ship_date", d);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };

  const seenSkuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  let skuToStyle = new Map();
  let skuToCode  = new Map();
  if (seenSkuIds.length > 0 && (input?.group_by ?? "style") !== "customer") {
    const { data: masters } = await db
      .from("ip_item_master").select("id, sku_code, style_code")
      .in("id", seenSkuIds);
    for (const m of (masters || [])) {
      if (m.style_code) skuToStyle.set(m.id, m.style_code);
      if (m.sku_code)   skuToCode.set(m.id, m.sku_code);
    }
  }

  const groupBy = input?.group_by ?? "style";
  const groups = new Map();
  for (const r of (data || [])) {
    let key;
    switch (groupBy) {
      case "sku":      key = skuToCode.get(r.sku_id) || r.sku_id; break;
      case "customer": key = r.customer_name || r.customer_id || "(no customer)"; break;
      case "month":    key = monthKey(r.ship_date); break;
      case "style":
      default:         key = skuToStyle.get(r.sku_id) || skuToCode.get(r.sku_id) || "(unmatched)"; break;
    }
    if (!groups.has(key)) groups.set(key, { key, qty_open: 0, qty_ordered: 0, qty_shipped: 0, value: 0, row_count: 0 });
    const g = groups.get(key);
    g.qty_open    += Number(r.qty_open    || 0);
    g.qty_ordered += Number(r.qty_ordered || 0);
    g.qty_shipped += Number(r.qty_shipped || 0);
    g.value       += Number(r.qty_open || 0) * Number(r.unit_price || 0);
    g.row_count   += 1;
  }
  const out = Array.from(groups.values()).sort((a, b) => b.qty_open - a.qty_open).slice(0, QUERY_RESULT_LIMIT);
  return {
    groups: out,
    group_count: groups.size,
    row_count: (data || []).length,
    capped: (data || []).length >= QUERY_ROW_LIMIT,
    group_by: groupBy,
  };
}

async function tool_query_open_pos(db, input) {
  const skuIdsResolved = await resolveSkuIdsForStyleOrSku(db, input);
  if (skuIdsResolved?.error) return { error: skuIdsResolved.error };
  const skuIds = skuIdsResolved?.ids ?? null;
  if (skuIds && skuIds.length === 0) {
    return { groups: [], note: "No SKUs matched the supplied style_code/sku_code." };
  }

  let q = db
    .from("ip_open_purchase_orders")
    .select("sku_id, vendor_id, expected_date, qty_ordered, qty_received, qty_open, unit_cost")
    .limit(QUERY_ROW_LIMIT);
  if (skuIds) q = q.in("sku_id", skuIds);
  if (input?.date_from) {
    const d = clampDate(input.date_from);
    if (!d) return { error: "date_from must be YYYY-MM-DD" };
    q = q.gte("expected_date", d);
  }
  if (input?.date_to) {
    const d = clampDate(input.date_to);
    if (!d) return { error: "date_to must be YYYY-MM-DD" };
    q = q.lte("expected_date", d);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };

  const seenSkuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  let skuToStyle = new Map();
  let skuToCode  = new Map();
  if (seenSkuIds.length > 0) {
    const { data: masters } = await db
      .from("ip_item_master").select("id, sku_code, style_code")
      .in("id", seenSkuIds);
    for (const m of (masters || [])) {
      if (m.style_code) skuToStyle.set(m.id, m.style_code);
      if (m.sku_code)   skuToCode.set(m.id, m.sku_code);
    }
  }

  const groupBy = input?.group_by ?? "style";
  const groups = new Map();
  for (const r of (data || [])) {
    let key;
    switch (groupBy) {
      case "sku":   key = skuToCode.get(r.sku_id) || r.sku_id; break;
      case "month": key = monthKey(r.expected_date); break;
      case "style":
      default:      key = skuToStyle.get(r.sku_id) || skuToCode.get(r.sku_id) || "(unmatched)"; break;
    }
    if (!groups.has(key)) groups.set(key, { key, qty_open: 0, qty_ordered: 0, qty_received: 0, cost: 0, row_count: 0 });
    const g = groups.get(key);
    g.qty_open    += Number(r.qty_open    || 0);
    g.qty_ordered += Number(r.qty_ordered || 0);
    g.qty_received+= Number(r.qty_received|| 0);
    g.cost        += Number(r.qty_open || 0) * Number(r.unit_cost || 0);
    g.row_count   += 1;
  }
  const out = Array.from(groups.values()).sort((a, b) => b.qty_open - a.qty_open).slice(0, QUERY_RESULT_LIMIT);
  return {
    groups: out,
    group_count: groups.size,
    row_count: (data || []).length,
    capped: (data || []).length >= QUERY_ROW_LIMIT,
    group_by: groupBy,
  };
}

// ── Generic cross-app discovery + query tools ────────────────────────

function tool_list_domains() {
  return {
    domains: Object.values(DOMAINS).map(d => ({
      domain: d.domain,
      description: d.description,
      table_count: Object.keys(d.tables).length,
    })),
  };
}

function tool_list_tables(input) {
  const domain = DOMAINS[input?.domain];
  if (!domain) return { error: `Unknown domain: ${input?.domain}. Valid: ${Object.keys(DOMAINS).join(", ")}` };
  return {
    domain: domain.domain,
    tables: Object.entries(domain.tables).map(([name, t]) => ({
      table: name,
      description: t.description,
      column_count: Object.keys(publicColumns(t)).length,
    })),
  };
}

function tool_describe_table(input) {
  const tableName = String(input?.table || "").trim();
  if (!tableName) return { error: "table required" };
  let found = null;
  if (input?.domain) {
    found = lookupTable(input.domain, tableName);
    if (!found) return { error: `Table '${tableName}' not in domain '${input.domain}' (or domain unknown).` };
  } else {
    for (const d of Object.values(DOMAINS)) {
      if (d.tables[tableName]) { found = { domain: d, table: d.tables[tableName], tableName, domainName: d.domain }; break; }
    }
    if (!found) return { error: `Unknown table: ${tableName}. Use list_tables(domain) to discover.` };
  }
  const cols = publicColumns(found.table);
  return {
    domain: found.domainName,
    table: tableName,
    description: found.table.description,
    columns: Object.entries(cols).map(([name, meta]) => ({
      name,
      type: meta.type,
      filterable: !!meta.filterable,
      groupable:  !!meta.groupable,
      aggregatable: !!meta.aggregatable,
      date: !!meta.date,
    })),
  };
}

// Validate + apply a single filter to a PostgREST query builder. Returns
// { ok, error? }. Op + column must be in the allowlist for that column
// type, and `in` values must be a non-empty array.
function applyFilter(q, table, { col, op, value }) {
  const meta = publicColumns(table)[col];
  if (!meta) return { ok: false, error: `Column '${col}' is not readable.` };
  if (!meta.filterable) return { ok: false, error: `Column '${col}' is not filterable.` };
  const allowed = ALLOWED_FILTER_OPS[meta.type] || [];
  if (!allowed.includes(op)) {
    return { ok: false, error: `Op '${op}' not allowed on '${col}' (type ${meta.type}). Allowed: ${allowed.join(", ")}.` };
  }
  switch (op) {
    case "eq":   q = q.eq(col, value); break;
    case "neq":  q = q.neq(col, value); break;
    case "gt":   q = q.gt(col, value); break;
    case "gte":  q = q.gte(col, value); break;
    case "lt":   q = q.lt(col, value); break;
    case "lte":  q = q.lte(col, value); break;
    case "in":
      if (!Array.isArray(value) || value.length === 0) return { ok: false, error: `'in' requires non-empty array for '${col}'.` };
      if (value.length > 50) return { ok: false, error: `'in' list capped at 50 values.` };
      q = q.in(col, value);
      break;
    case "ilike": q = q.ilike(col, String(value)); break;
    case "is_null":     q = q.is(col, null); break;
    case "not_is_null": q = q.not(col, "is", null); break;
  }
  return { ok: true, q };
}

async function tool_query_table(db, input) {
  // ── Validate table ──
  const tableName = String(input?.table || "").trim();
  if (!tableName) return { error: "table required" };
  let found = null;
  if (input?.domain) {
    found = lookupTable(input.domain, tableName);
    if (!found) return { error: `Table '${tableName}' not in domain '${input.domain}'.` };
  } else {
    for (const d of Object.values(DOMAINS)) {
      if (d.tables[tableName]) { found = { domain: d, table: d.tables[tableName], tableName, domainName: d.domain }; break; }
    }
    if (!found) return { error: `Unknown table: ${tableName}.` };
  }
  const table   = found.table;
  const colMeta = publicColumns(table);

  // ── Validate group_by ──
  const groupBy = Array.isArray(input?.group_by) ? input.group_by.slice(0, 3) : [];
  for (const g of groupBy) {
    if (!colMeta[g]) return { error: `group_by column '${g}' not readable on '${tableName}'.` };
    if (!colMeta[g].groupable) return { error: `Column '${g}' is not groupable.` };
  }

  // ── Validate aggregations ──
  const aggs = Array.isArray(input?.aggregations) ? input.aggregations : [];
  for (const a of aggs) {
    if (!ALLOWED_AGGS.includes(a.fn)) return { error: `Unknown aggregation: ${a.fn}` };
    if (a.fn !== "count") {
      if (!a.col) return { error: `aggregation ${a.fn} requires a col.` };
      if (!colMeta[a.col]) return { error: `agg col '${a.col}' not readable on '${tableName}'.` };
      if (!colMeta[a.col].aggregatable) return { error: `Column '${a.col}' is not aggregatable.` };
    }
  }

  // ── Build column selector. We only fetch what we need: group_by cols
  // + agg target cols. PostgREST doesn't do SQL GROUP BY without RPC,
  // so we pull the rows (capped) and aggregate in-memory.
  const selectCols = new Set();
  for (const g of groupBy) selectCols.add(g);
  for (const a of aggs) if (a.col) selectCols.add(a.col);
  // If neither group_by nor aggs, pull all readable cols (capped).
  if (selectCols.size === 0) {
    for (const c of Object.keys(colMeta).slice(0, 12)) selectCols.add(c);
  }
  const selectStr = Array.from(selectCols).join(", ");

  // ── Build query ──
  let q = db.from(tableName).select(selectStr).limit(QUERY_ROW_LIMIT);

  // Filters
  const filters = Array.isArray(input?.filters) ? input.filters : [];
  if (filters.length > 20) return { error: "Too many filters (cap 20)." };
  for (const f of filters) {
    const r = applyFilter(q, table, f);
    if (!r.ok) return { error: r.error };
    q = r.q;
  }

  // Date range convenience
  if (input?.date_range && input.date_range.col) {
    const dr = input.date_range;
    const meta = colMeta[dr.col];
    if (!meta) return { error: `date_range.col '${dr.col}' not readable.` };
    if (!meta.date) return { error: `Column '${dr.col}' is not a date column.` };
    if (dr.from) {
      const d = clampDate(dr.from);
      if (!d) return { error: "date_range.from must be YYYY-MM-DD." };
      q = q.gte(dr.col, d);
    }
    if (dr.to) {
      const d = clampDate(dr.to);
      if (!d) return { error: "date_range.to must be YYYY-MM-DD." };
      q = q.lte(dr.col, d);
    }
  }

  const { data, error } = await q;
  if (error) return { error: error.message };
  const rows = data || [];

  // ── Aggregate in-memory ──
  if (groupBy.length === 0 && aggs.length === 0) {
    // Plain rows mode
    const limit = Math.min(Math.max(1, Number(input?.limit) || 50), 200);
    return {
      mode: "rows",
      row_count: rows.length,
      capped: rows.length >= QUERY_ROW_LIMIT,
      rows: rows.slice(0, limit),
    };
  }

  // Group rows
  const groups = new Map();
  for (const r of rows) {
    const key = groupBy.map(g => String(r[g] ?? "(null)")).join(" | ");
    if (!groups.has(key)) {
      const seed = { _group: {} };
      for (const g of groupBy) seed._group[g] = r[g] ?? null;
      groups.set(key, { ...seed, _rows: [] });
    }
    groups.get(key)._rows.push(r);
  }

  // Compute aggregations per group
  const outRows = [];
  for (const g of groups.values()) {
    const out = { ...g._group };
    for (const a of aggs) {
      const alias = a.as || (a.fn === "count" ? "count" : `${a.fn}_${a.col}`);
      if (a.fn === "count") {
        out[alias] = g._rows.length;
        continue;
      }
      const vals = g._rows.map(r => Number(r[a.col] || 0));
      switch (a.fn) {
        case "sum": out[alias] = vals.reduce((s, v) => s + v, 0); break;
        case "avg": out[alias] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0; break;
        case "min": out[alias] = vals.length ? Math.min(...vals) : null; break;
        case "max": out[alias] = vals.length ? Math.max(...vals) : null; break;
      }
    }
    outRows.push(out);
  }

  // Order
  if (input?.order_by?.col) {
    const c = input.order_by.col;
    const dir = input.order_by.dir === "asc" ? 1 : -1;
    outRows.sort((a, b) => {
      const av = a[c]; const bv = b[c];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  } else if (aggs.length > 0) {
    // Default: order by the first aggregation desc.
    const a0 = aggs[0];
    const alias = a0.as || (a0.fn === "count" ? "count" : `${a0.fn}_${a0.col}`);
    outRows.sort((a, b) => (Number(b[alias]) || 0) - (Number(a[alias]) || 0));
  }

  const limit = Math.min(Math.max(1, Number(input?.limit) || 50), 200);
  return {
    mode: "groups",
    domain: found.domainName,
    table: tableName,
    group_count: outRows.length,
    row_count: rows.length,
    capped: rows.length >= QUERY_ROW_LIMIT,
    group_by: groupBy,
    aggregations: aggs,
    groups: outRows.slice(0, limit),
  };
}

const TOOL_EXECUTORS = {
  find_customer:    tool_find_customer,
  find_style:       tool_find_style,
  query_shipments:  tool_query_shipments,
  query_open_sos:   tool_query_open_sos,
  query_open_pos:   tool_query_open_pos,
  list_domains:     async () => tool_list_domains(),
  list_tables:      async (_db, input) => tool_list_tables(input),
  describe_table:   async (_db, input) => tool_describe_table(input),
  query_table:      tool_query_table,
};

const TERMINAL_TOOLS = new Set([
  "apply_filters", "set_sort", "clear_filters",
  "answer_text", "suggest_grid_view",
]);

// ─────────────────────────────────────────────────────────────────────────

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
  lines.push(`Today's date: ${new Date().toISOString().slice(0, 10)}`);
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

function summarizeToolResult(name, result) {
  if (!result || typeof result !== "object") return `${name}: ok`;
  if (result.error) return `${name}: error — ${String(result.error).slice(0, 120)}`;
  if (name === "find_customer")  return `find_customer: ${result.count ?? 0} match(es)`;
  if (name === "find_style")     return `find_style: ${result.count ?? 0} style(s)`;
  if (name === "list_domains")   return `list_domains: ${result.domains?.length ?? 0} domains`;
  if (name === "list_tables")    return `list_tables(${result.domain}): ${result.tables?.length ?? 0} tables`;
  if (name === "describe_table") return `describe_table(${result.table}): ${result.columns?.length ?? 0} cols`;
  if (name === "query_table") {
    return `query_table(${result.table ?? "?"}): ${result.mode === "rows" ? `${result.rows?.length ?? 0} rows` : `${result.group_count ?? 0} group(s)`} from ${result.row_count ?? 0}${result.capped ? " (CAPPED)" : ""}`;
  }
  if (name.startsWith("query_")) {
    const t = result.totals;
    const sums = t ? ` totals=qty:${t.qty?.toFixed?.(0) ?? "?"} amt:${t.net_amount?.toFixed?.(0) ?? "?"}` : "";
    return `${name}: ${result.group_count ?? 0} group(s) from ${result.row_count ?? 0} rows${result.capped ? " (CAPPED)" : ""}${sums}`;
  }
  return `${name}: ok`;
}

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

  // Same-origin guard. The endpoint is internal — only the deployed app
  // domain should be calling it. Anyone hitting it from a different origin
  // is either misconfigured or hostile; reject early. Allowed origins
  // come from ALLOWED_AI_ORIGINS (comma-separated) with a sensible
  // default for the production Vercel URL + localhost dev.
  const origin  = req.headers?.origin  || "";
  const referer = req.headers?.referer || "";
  const allowedOrigins = (process.env.ALLOWED_AI_ORIGINS || "https://design-calendar-app.vercel.app,http://localhost:5173,http://localhost:3000")
    .split(",").map(s => s.trim()).filter(Boolean);
  // Parse the referer to its origin so attackers can't smuggle a
  // matching prefix with a subdomain trick like
  // `https://design-calendar-app.vercel.app.attacker.com/x`.
  let refererOrigin = "";
  try { if (referer) refererOrigin = new URL(referer).origin; } catch { refererOrigin = ""; }
  const fromOrigin  = origin         && allowedOrigins.includes(origin);
  const fromReferer = refererOrigin  && allowedOrigins.includes(refererOrigin);
  if (!fromOrigin && !fromReferer) {
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
  const trace = [];

  // Prompt-caching markers. System prompt + tool definitions are
  // identical on every iteration of the loop AND across requests, so
  // marking the last system block + last tool as cache_control hints
  // Anthropic to cache up to (and including) those segments. Cache
  // hits cost ~1/10th the input tokens and shave noticeable latency
  // off iteration 2+ inside the same conversation.
  const SYSTEM_CACHED = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ];
  const TOOLS_CACHED = TOOLS.map((t, i) =>
    i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
  );

  // Streaming dispatch — when the client says Accept: text/event-stream,
  // hand off to runStreaming. Operators see "Searching customers…" /
  // "Querying shipments…" status + token-by-token answer instead of a
  // static spinner. Non-streaming JSON path kept for non-browser callers.
  const accept = String(req.headers?.accept || "");
  if (accept.includes("text/event-stream")) {
    return runStreaming(req, res, {
      client, db, messages, SYSTEM_CACHED, TOOLS_CACHED, trace,
    });
  }

  let totalIn  = 0;
  let totalOut = 0;
  let totalCost = 0;
  let finalMessage = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_CACHED,
        tools: TOOLS_CACHED,
        messages,
      });
    } catch (err) {
      await logAICall(db, { handler: HANDLER, model: MODEL, cost_usd: totalCost, error: err.message });
      return res.status(502).json({ error: `Claude API error: ${err.message}`, trace });
    }

    totalIn  += resp.usage?.input_tokens  ?? 0;
    totalOut += resp.usage?.output_tokens ?? 0;
    totalCost += estimateClaudeCost(resp);
    finalMessage = resp;

    const toolUses = (resp.content || []).filter(b => b.type === "tool_use");
    if (toolUses.length === 0) break;

    // If every tool call this turn is terminal, we're done — execute them
    // client-side and return without another Claude round-trip.
    const hasNonTerminal = toolUses.some(t => !TERMINAL_TOOLS.has(t.name));
    if (!hasNonTerminal) break;

    // Run the non-terminal (DB query) tools server-side in PARALLEL —
    // Claude often emits 2-3 lookups per turn (find_customer + find_style,
    // or two query_* in one go) and serial execution was wasting 100-500ms
    // per extra call. Terminal tools just need an empty ack block.
    const toolResults = await Promise.all(toolUses.map(async (tu) => {
      if (TERMINAL_TOOLS.has(tu.name)) {
        return { type: "tool_result", tool_use_id: tu.id, content: "ok" };
      }
      const exec = TOOL_EXECUTORS[tu.name];
      let result;
      try {
        result = exec
          ? await exec(db, tu.input || {})
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
  const actions    = [];
  let suggestion  = null;
  for (const block of (finalMessage?.content || [])) {
    if (block.type === "tool_use") {
      if (block.name === "answer_text") {
        text = String(block.input?.text || "").trim();
      } else if (block.name === "suggest_grid_view") {
        suggestion = {
          label: String(block.input?.label || "Apply to grid"),
          filters: block.input?.filters || {},
        };
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
    model: MODEL,
    input_tokens:  totalIn,
    output_tokens: totalOut,
    cost_usd: totalCost,
  });

  return res.status(200).json({
    text,
    actions,
    suggestion,
    trace,
    token_usage: {
      input_tokens:  totalIn,
      output_tokens: totalOut,
      cost_usd:      totalCost,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Streaming variant — Server-Sent Events. Client opts in via
// `Accept: text/event-stream`. Events emitted:
//   stage     {label}                  — friendly description of the
//                                        current step (e.g. "Searching
//                                        customers…", "Querying shipments…")
//   text_delta {text}                  — incremental chunks of the final
//                                        answer as Claude generates it
//   complete  {text, actions,          — terminal payload (same shape as
//              suggestion, trace,        the non-streaming JSON response)
//              token_usage}
//   error     {error}                  — terminal error
//
// Operator perception of latency drops massively even when total wall
// time is unchanged — they see what the AI is doing instead of staring
// at "Thinking…".
// ─────────────────────────────────────────────────────────────────────────

const TOOL_LABELS = {
  find_customer:   "Searching customers…",
  find_style:      "Looking up styles…",
  query_shipments: "Querying shipment history…",
  query_open_sos:  "Checking open sales orders…",
  query_open_pos:  "Checking incoming POs…",
  list_domains:    "Scanning available data sources…",
  list_tables:     "Listing tables…",
  describe_table:  "Reading schema…",
  query_table:     "Running database query…",
};

function sseWrite(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function runStreaming(req, res, opts) {
  const {
    client, db, messages, SYSTEM_CACHED, TOOLS_CACHED, trace,
  } = opts;

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
  // Track text incrementally streamed for the answer_text tool input.
  // Anthropic emits the tool's input as partial JSON; we accumulate and
  // extract the "text" string as it grows so the panel can render token
  // by token without waiting for the full JSON to close.
  let pendingAnswerText = "";
  let lastEmittedAnswerText = "";

  function extractAnswerTextFromPartialJson(json) {
    // Look for `"text":"...` — find the value and unescape up to the
    // last completed character. Stops cleanly at an in-progress escape.
    const m = /"text"\s*:\s*"((?:\\.|[^"\\])*)/.exec(json);
    if (!m) return "";
    let s = m[1];
    // Strip a trailing incomplete escape sequence (e.g. ends in `\`).
    if (s.endsWith("\\")) s = s.slice(0, -1);
    // Best-effort unescape of the common ones.
    return s
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\t/g, "\t");
  }

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (clientGone) return;
      sseWrite(res, "stage", { label: iter === 0 ? "Thinking…" : "Continuing…" });

      const stream = await client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
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
          // "Let me look that up…") are intentionally NOT streamed.
          // They were leaking before the real answer_text in multi-tool
          // conversations and corrupting the final bubble. Only the
          // terminal answer_text streams.
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
            ? await exec(db, tu.input || {})
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
    const actions    = [];
    let suggestion  = null;
    for (const block of finalContent) {
      if (block.type === "tool_use") {
        if (block.name === "answer_text") {
          text = String(block.input?.text || "").trim();
        } else if (block.name === "suggest_grid_view") {
          suggestion = {
            label: String(block.input?.label || "Apply to grid"),
            filters: block.input?.filters || {},
          };
        } else if (TERMINAL_TOOLS.has(block.name)) {
          actions.push({ type: block.name, params: block.input || {} });
        }
      } else if (block.type === "text" && typeof block.text === "string") {
        const t = block.text.trim();
        if (t) text = text ? `${text}\n\n${t}` : t;
      }
    }

    await logAICall(db, {
      handler: HANDLER, model: MODEL,
      input_tokens: totalIn, output_tokens: totalOut, cost_usd: totalCost,
    });

    sseWrite(res, "complete", {
      text, actions, suggestion, trace,
      token_usage: { input_tokens: totalIn, output_tokens: totalOut, cost_usd: totalCost },
    });
    res.end();
  } catch (err) {
    await logAICall(db, { handler: HANDLER, model: MODEL, cost_usd: totalCost, error: err.message });
    sseWrite(res, "error", { error: `Claude API error: ${err.message}`, trace });
    res.end();
  }
}
