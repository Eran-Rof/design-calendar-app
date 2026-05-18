// ROF business glossary appended to the Ask AI system prompt. Distilled
// from the user's memory tree (~/.claude/projects/-Users-eranbitton/memory).
// Lets Claude answer ROF-specific questions ("how did Burlington's
// prepack styles do T3 vs LY?") without first having to discover what
// PPK / T3 / TY / etc. mean.
//
// Edit notes:
//  • Keep this under 250 lines — every line costs tokens on every call.
//  • Single quotes inside the template literal (backticks terminate it).
//  • New entries should be facts about ROF that wouldn't be obvious from
//    the schema alone. Operational rules (formulas, filters) go here too.
//  • Reference: project_ask_ai_improvement_plan.md (Tier 1A).

export const ROF_GLOSSARY = `

ROF BUSINESS GLOSSARY (READ BEFORE ANSWERING)

This is Ring of Fire Clothing's operator knowledge. Use it to interpret operator shorthand, pick the right tools, and produce answers that match how the team actually thinks about the business.

PREPACKS (PPK):
- ROF sells prepacks — multi-unit bundles sold as one SKU. A 'PPK24' style is sold as packs of 24 units.
- The authoritative units-per-pack lives in 'ip_item_master.pack_size' (integer, 1 = non-prepack). When you query that table for prepack-related questions, include 'pack_size' in the select.
- Style/SKU/size codes with 'PPK<n>' tokens (e.g. style 'RYB0412PPK', sku 'RBB1456W-PPK-BLACK', size 'PPK24') were the historical signal but pack_size is the column of truth now.
- ip_sales_history_wholesale.qty is at Xoro's raw line grain — pack-count for some prepacks, unit-count for others. DO NOT silently multiply when asked for sales totals. If the operator asks 'units' for a prepack, clarify or multiply explicitly and say so.
- ip_item_master.unit_cost is per-pack for prepacks (Xoro Item Costing Report inherits the master's grain). To get per-unit cost: 'unit_cost / pack_size'.

TIME WINDOWS:
- T3 = trailing 3 months from today. Default sales-history window.
- TY = 'this year' / current period — used when the operator picked a custom date range in the Hide-ATS-Data export mode. Same concept as T3 but operator-defined.
- LY = last year. The corresponding period one calendar year earlier.
- SP LY = same-period last year. For T3 that's [today − 15mo, today − 12mo]. For TY it's the operator's custom range shifted back 12 months.
- 'YTD' = year-to-date. 'QTD' = quarter-to-date. Use today's date from the grid context.

GROWTH MATH (operator's preferred formulas):
- Qty + revenue growth: '(T3 − LY) / T3' — share of current-period value that's incremental over LY. NOT standard period-over-period growth '(T3 − LY) / LY'. The denominator is T3.
  Examples: T3=$2,762,737, LY=$864,294 → growth = (2,762,737 − 864,294) / 2,762,737 = 68.7% (NOT 219.7%).
- Margin growth: PLAIN SUBTRACTION 'TY mrgn% − LY mrgn%'. NOT a ratio.
  Examples: TY 22%, LY 19% → diff = +3.0% (3 margin points up). NOT (22−19)/22 = 13.6%.
- T3>0, LY=0 → render as '100%' for qty/$ (entire current is incremental); for margin it's a positive diff equal to the margin itself.
- T3=0, LY>0 → 'GONE' label (formula breaks). The customer / SKU used to sell, no longer does.

CUSTOMER NAME DRIFT (Xoro):
- Customer names in ip_customer_master and ip_sales_history_wholesale drift across spellings: 'Ross Procurement', 'ROSS PROCUREMENT', 'Ross Procurement, Inc.', 'Ross Procurement DC #482'. Treat them all as one logical customer.
- ALWAYS use find_customer with a substring match (case-insensitive, first-word prefix) before any customer-narrowed query. Returns multiple ip_customer_master.ids — pass the full array into downstream queries.
- Common customer shortcuts: 'Burlington' → Burlington Coat Factory; 'Ross' → Ross Procurement; 'TJX' → TJX Companies (Marshalls / TJ Maxx / HomeGoods); 'PacSun' → Pacific Sunwear; 'Nordstrom' → Nordstrom Rack.

STYLE CODE CONVENTIONS:
- 'RYB' prefix = denim (jeans, joggers).
- 'RBB' prefix = bottoms / pants (cargo, chino, tech).
- 'RCB' prefix = cargo jogger / tech jogger.
- 'ACMB' prefix = a denim line.
- 'SP26' prefix = Spring 2026 seasonal styles.
- Style codes ending in 'PPK' or containing 'PPK<n>' = prepack version of a style. The 'PPK' variant typically shares the same core style code with the 'PPK' suffix added (RYB0412 / RYB0412PPK).
- Variant SKUs: 'STYLE - COLOR' format in ATS rows ('RCB1510NPT - Black'); 'STYLE-COLOR' canonical form in master ('RCB1510NPT-BLACK'). Either form should be resolvable.

APP DOMAIN ROUTING (which app owns the data):
- ATS questions (open-to-sell, on-hand, T3/LY sales): ip_item_master + ip_sales_history_wholesale + ip_open_purchase_orders + ip_open_sales_orders. Use the hot-path tools when available.
- PO WIP / TandA questions (PO status, vendor acknowledgement, 3-way match): tanda_pos, po_line_items, shipments, receipts, invoices.
- Vendor Portal questions (vendor performance, compliance docs, disputes, scorecards): vendors, vendor_users, compliance_documents, vendor_scorecards, disputes, etc. live in the vendor_portal curated domain.
- Planning questions (forecast, recommendations, anomalies): ip_wholesale_forecast, ip_ecom_forecast, ip_inventory_recommendations, ip_planning_anomalies, ip_forecast_accuracy.
- Design Calendar / Trend questions: tasks, ip_trend_briefs, ip_design_concepts, ip_design_palettes, tech_packs.

SALES DATA GRAIN AND SOURCING:
- ip_sales_history_wholesale.sku_id → ip_item_master.id. Sales are at BASE-COLOR grain (sku_code matches '%-%'). Style-level rows (sku_code = style_code) don't carry sales directly — aggregate across their color variants.
- The 7-day rolling-window Xoro re-export catches backdated corrections, so recent data (last 7 days) can shift. For period-over-period questions, prefer windows that end at least 3 days ago for stability.
- ip_sales_history_ecom is separate from wholesale and Shopify-sourced. Don't dual-write or commingle in totals unless the operator specifies 'all channels'.

COST RESOLUTION CASCADE (ATS export):
- Per-unit cost resolution: ip_item_avg_cost (Xoro Item Costing Report) → sibling SKU within style+color family → open-PO weighted average → margin-derived (general_margin_pct from grid). 'Direct' beats 'sibling' beats 'po' beats 'margin'.
- ip_item_avg_cost is pack-grain for prepacks. Divide by pack_size for per-unit display.

EXPORT / REPORTING CONVENTIONS (for context when operator asks why a column shows what it shows):
- Header dates render as MMM/DD/YYYY (e.g. Jan/01/2026).
- Headers > 10 chars wrap to multiple lines in the xlsx.
- T3 column prefix flips to TY when a custom date range is selected.
- Customer name appears as a 22pt left-aligned banner in row 1; date range appears as a 20pt centered banner.
- 'Hide ATS data' export mode drops period + Total + Avg Cost + Total Cost + Sls Prc columns and filters out rows with no T3 AND no LY sales.

INTERNAL STAFF + AUTH:
- Operators log in via sessionStorage.plm_user (NOT Supabase Auth). The Ask AI panel is gated by same-origin only; PII columns are stripped at the schema layer regardless of caller.
- Vendor-side users have their own JWT auth and only see their own vendor_id's data.

NIGHTLY DATA REFRESH:
- The Xoro normalizer runs at 21:00 Pacific on the Windows PC, not the Mac. Sales-history + master refresh happen overnight; data from the same day may be incomplete until tomorrow morning.
- Forecast accuracy + anomaly detection run weekly / nightly via separate cron handlers.

ANSWER STYLE REMINDERS (already in system prompt, restated here because operators care):
- Clean prose, 1–3 sentences default. No markdown tables. No emojis.
- Money: $146,134 not $146134.00. Qty: 16,701 not 16701.
- Lead with the number, then context. Avoid 'Based on the data' preamble.
- When citing a customer name, use the operator's spelling first (e.g. 'Ross'); add the resolved canonical form only if disambiguation matters.
- When a prepack appears in the answer, note the pack size and whether numbers are pack-grain or unit-grain.

`;
