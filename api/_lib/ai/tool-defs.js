// Tool definitions handed to Claude on every messages.create call.
// Schema-mirror: every entry here MUST have a matching executor in
// executors.js (or be in TERMINAL_TOOLS in constants.js). Adding a
// new tool requires both sides.
//
// Grouped: grid mutations (terminal) → hot-path DB lookups (looped) →
// reply tools (terminal) → cross-app discovery + generic query (looped).

import { ALLOWED_AGGS } from "./schema.js";
import { panelKeys, allActionNames } from "../assistant/registry.js";

// P28-2 - the open_panel allowlist comes from the capability-pack registry,
// so a pack adding a routable panel automatically widens the tool schema.
const PANEL_KEYS = [...panelKeys()].sort();

// P28-4 - the run_action allowlist likewise comes from the registry, so a
// pack adding an action auto-widens the schema. Empty in P28-4-1 (no pack
// ships an action yet) — when empty the `action` arg stays a free string so
// the JSON Schema never carries an empty (invalid) enum.
const ACTION_NAMES = [...allActionNames()].sort();
const ACTION_PROP = ACTION_NAMES.length
  ? { type: "string", enum: ACTION_NAMES, description: "Action name from the pack registry." }
  : { type: "string", description: "Action name from the pack registry." };

export const TOOLS = [
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
    description: "Aggregate historical wholesale shipments (ip_sales_history_wholesale) for a customer (or set of customer IDs that resolve to the same logical customer via Xoro spelling drift) and/or style/SKU within a date range. Returns rows grouped by style_code with total qty + net_amount. Use this for 'how much did we ship X to Y in period Z' questions. CRITICAL: when narrowing by customer, ALWAYS pass customer_ids (plural array) with ALL ids find_customer returned, not just the first match.",
    input_schema: {
      type: "object",
      properties: {
        customer_id:  { type: "string",  description: "DEPRECATED — pass customer_ids array instead. Kept for backward compat; coerced to a single-item array." },
        customer_ids: { type: "array", items: { type: "string" }, description: "ip_customer_master.id list. PREFERRED. Use ALL ids find_customer returned for the requested customer name — Xoro drift means one logical customer maps to multiple master rows." },
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
    description: "Aggregate open sales orders (ip_open_sales_orders). Filter by customer (PREFERRED: customer_ids array — Xoro spelling drift), style/SKU, and ship_date range. Returns grouped totals for qty_open / qty_ordered / qty_shipped.",
    input_schema: {
      type: "object",
      properties: {
        customer_id:  { type: "string",  description: "DEPRECATED — pass customer_ids array instead. Coerced to single-item array." },
        customer_ids: { type: "array", items: { type: "string" }, description: "ip_customer_master.id list. PREFERRED. Use ALL ids find_customer returned." },
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

  // ── Margin (single-call, no fabrication possible) ────────────────────
  {
    name: "query_margin",
    description: "ONE-CALL MARGIN COMPUTATION. Use this for ANY margin question ('what was Ross's margin LY', 'margin % on Edge T3', 'margin $ for slim denim in 2025'). Fetches revenue from ip_sales_history_wholesale + per-SKU avg_cost from ip_item_avg_cost + computes COGS = Σ(qty × avg_cost), margin_$ = revenue − COGS, margin_% = margin_$ / revenue server-side. Returns coverage stats — if some SKUs lack avg_cost, the tool tells you exactly which $ and % of revenue is covered. DO NOT fabricate a margin rate, sample average, or 'representative midpoint' — call this tool and report what it returns. Same customer_ids array rule as query_shipments (always pass the full array find_customer returned, never just one).",
    input_schema: {
      type: "object",
      properties: {
        customer_id:  { type: "string", description: "DEPRECATED — pass customer_ids array instead." },
        customer_ids: { type: "array", items: { type: "string" }, description: "ip_customer_master.id list. Use ALL ids find_customer returned for the requested customer name." },
        style_code:   { type: "string", description: "ip_item_master.style_code; filters all SKU variants in the family." },
        sku_code:     { type: "string", description: "ip_item_master.sku_code; exact SKU filter." },
        date_from:    { type: "string", description: "ISO date YYYY-MM-DD; inclusive lower bound on txn_date." },
        date_to:      { type: "string", description: "ISO date YYYY-MM-DD; inclusive upper bound on txn_date." },
      },
      required: ["date_from", "date_to"],
      additionalProperties: false,
    },
  },

  // ── Entity cards (single-call snapshots) ──────────────────────────────
  {
    name: "style_card",
    description: "One-call snapshot of a style: master facts (description, category, pack_size, variant count, distinct colors), T3 vs LY sales (qty + revenue + growth share), top 5 T3 customers by revenue, open SO + PO commitments. Use this whenever the operator names a single style_code and wants orientation ('how is RYB0412 doing', 'tell me about RCB1510NPT'). Faster than find_style + describe_table + query_shipments + query_open_sos in sequence.",
    input_schema: {
      type: "object",
      properties: {
        style_code: { type: "string", description: "Exact style_code (canonical, not the variant SKU). Use find_style first if you only have a fragment." },
      },
      required: ["style_code"],
      additionalProperties: false,
    },
  },
  {
    name: "start_workflow",
    description: "Run a named multi-step cross-app workflow server-side and get back a single rich payload. Use this when the operator asks for one of these pre-built reports by name (or by intent). Available workflows: 'underperformer_review' (top-N styles whose T3 revenue dropped vs LY, with their open-PO exposure for cancellation review); 'customer_churn_check' (customers whose T3 revenue dropped ≥ 25% vs LY, with their open-SO exposure); 'monday_briefing' (one-call dashboard: T3 totals, top 5 customers, top 5 styles, open SO + open PO snapshot). Each runs 4-8 sub-queries server-side — faster + cheaper than orchestrating the same chain with one-off tools. After the tool returns, summarise the result in answer_text using the numbers it provides; do NOT re-derive or fabricate.",
    input_schema: {
      type: "object",
      properties: {
        workflow_name: { type: "string", enum: ["underperformer_review", "customer_churn_check", "monday_briefing"], description: "Which workflow to run." },
        params: { type: "object", description: "Workflow-specific parameters. underperformer_review: { top_n? }. customer_churn_check: { drop_threshold_pct?, top_n? }. monday_briefing: none.", additionalProperties: true },
      },
      required: ["workflow_name"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_user_facts",
    description: "Look up operator-authored facts on a topic — call this BEFORE answering any question that mentions a specific style code, customer name, or named process (e.g. 'discount calc', 'forecast accuracy'). Operators leave free-text notes here that refine or contradict what the schema/data alone would suggest. Returns up to 5 facts ranked operator's-own > global. If no facts match, returns count:0 — proceed with the normal flow. Topic is a substring match (case-insensitive), so 'RYB0412' matches a fact tagged 'RYB0412PPK24' and 'burlington' matches 'Burlington Coat Factory'.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Keyword to search for in fact topics. Usually a style code, customer name, or short topic like 'discount calc'." },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "customer_card",
    description: "One-call snapshot of a customer: resolved IDs (Xoro spellings drift), T3 vs LY sales (qty + revenue + growth share), top 5 T3 styles by revenue, open SO commitments in $. Use this whenever the operator names a single customer and wants orientation ('how is Burlington doing', 'snapshot Ross'). Pass either customer_id (exact uuid) or customer_name (substring — same resolution as find_customer).",
    input_schema: {
      type: "object",
      properties: {
        customer_id:   { type: "string", description: "ip_customer_master.id (exact uuid)." },
        customer_name: { type: "string", description: "Free-text name; substring + first-word prefix matching like find_customer." },
      },
      additionalProperties: false,
    },
  },

  {
    name: "search_user_guide",
    description: "Search the Tangerine user guide (the operator documentation, 40 chapters) for how-to / where-is / what-does-X-mean questions. Call this for any question about HOW to do something in the app, where a screen or setting lives, what a term or workflow means, or app behaviour — instead of guessing. Returns the most relevant guide sections (chapter, heading, excerpt). After it returns, answer from the excerpts and cite the chapter; if nothing matches, say so rather than inventing steps. This reads documentation, not live data — use the database tools (query_table etc.) for actual numbers.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords from the user's question, e.g. 'post a manual journal entry', 'where is fixed assets', 'what is GR/IR'." },
        max_sections: { type: "number", description: "How many guide sections to return (default 4, max 6)." },
      },
      required: ["query"],
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
  {
    name: "suggest_followups",
    description: "After answering, propose 2-3 short follow-up questions the operator is likely to want next. Each should be a self-contained question (not a fragment), grounded in the same entities just discussed (style, customer, period). Examples: 'Show monthly breakdown for that period', 'Same numbers for last year', 'Which other customers buy this style?'. Keep each ≤ 70 chars so it fits in a chip. Do NOT call when the answer is itself a clarifying question or when you're not confident any of the suggestions are useful.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "string" },
          description: "Array of 1-3 follow-up question strings, ≤ 70 chars each.",
        },
      },
      required: ["questions"],
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
        domain: { type: "string", description: "One of: po_wip, vendor_portal, planning, design_calendar, live_db." },
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

  // ── P28-2 assistant-first tools ───────────────────────────────────────
  {
    name: "get_today",
    description: "The operator's live Today aggregate: their to-dos (queues waiting on them, with counts + severity), active process states (mirror runs, EDI outbox), and coded suggestions - already filtered to their access rights and today's dismissals. Call this when the operator asks what they should work on, what's waiting, how their day looks, or anything about 'my to-dos' / 'my queue'. Cite ONLY items it returns.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_panel",
    description: "Navigate the operator's Tangerine screen to a panel (terminal - the client performs the navigation). Use when the operator picks something to work on ('let's do the approvals', 'open the chargebacks') or asks to go somewhere. Combine with a short answer_text saying what you opened and why. Panel keys map to the modules on the Today page items ('panel' field of get_today results).",
    input_schema: {
      type: "object",
      properties: {
        panel: { type: "string", enum: PANEL_KEYS, description: "Target panel key - use the 'panel' value from the matching get_today item." },
        q: { type: "string", description: "Optional search text to seed the target panel's search box." },
      },
      required: ["panel"],
      additionalProperties: false,
    },
  },

  // ── P28-4 draft actions ───────────────────────────────────────────────
  {
    name: "run_action",
    description: "Preview a drafted action the operator can confirm (a chargeback link, a proposed reclass, etc.). LOOPED + read-only: run_action NEVER writes — it returns a human-readable preview and, for write actions, a signed confirmation the operator must approve. mode:'read' actions return data you summarise. mode:'draft'/'write_confirm' actions return { status:'needs_confirmation', summary, token } — then emit present_confirmation with that summary + token + action so the operator sees a Confirm card. If the tool returns { error }, tell the operator plainly and do NOT retry blindly.",
    input_schema: {
      type: "object",
      properties: {
        action: ACTION_PROP,
        input:  { type: "object", description: "Action-specific input (matches the action's input_schema).", additionalProperties: true },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "present_confirmation",
    description: "Terminal — show the operator a Confirm card for a drafted write. Call ONLY after run_action returned { status:'needs_confirmation', token }. Pass its summary, token, and action verbatim; the client renders Confirm/Cancel and, on Confirm, performs the authenticated write. Never fabricate a token. Combine with a short answer_text explaining what will happen.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line description of the write, from run_action." },
        token:   { type: "string", description: "The confirmation token run_action returned. Verbatim." },
        action:  { type: "string", description: "The action name being confirmed." },
      },
      required: ["summary", "token", "action"],
      additionalProperties: false,
    },
  },
];
