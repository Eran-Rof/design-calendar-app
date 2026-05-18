// Tool definitions handed to Claude on every messages.create call.
// Schema-mirror: every entry here MUST have a matching executor in
// executors.js (or be in TERMINAL_TOOLS in constants.js). Adding a
// new tool requires both sides.
//
// Grouped: grid mutations (terminal) → hot-path DB lookups (looped) →
// reply tools (terminal) → cross-app discovery + generic query (looped).

import { ALLOWED_AGGS } from "./schema.js";

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
    description: "Propose 2-3 short, plausible follow-up questions tied to the answer you just gave. Surfaced in the UI as clickable chips so the operator can drill in without retyping. Use this for almost every answer EXCEPT pure grid mutations (apply_filters / set_sort / clear_filters) — those don't have natural drill-down questions. Each question should be one short sentence (≤80 chars), self-contained (no 'them' / 'it' that needs context), and target a different angle than the question just asked.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 3,
          description: "2-3 follow-up question strings. Plain prose, no preamble, no numbering, no quotation marks.",
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
];
