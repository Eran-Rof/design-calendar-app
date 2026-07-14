// ════════════════════════════════════════════════════════════════════════════
// Cross-cutter T4-2 — Personalization: in-app menu-key registry.
//
// Single source of truth for every clickable nav destination across the five
// PLM apps (Design Calendar, ATS, PO WIP, GS1, Tanda/Tangerine). Used by:
//
//   • favorites side drawer            — operator pins menu_keys to favorites
//   • personalized landing (home_route) — settings → "open this on launch"
//   • menu-click telemetry              — POST /api/internal/users/me/menu-click
//   • top-N "Most Used" panel           — GET /api/internal/users/me/menu-usage/top
//
// A menu_key is a stable, kebab-case, app-prefixed identifier that survives
// label renames and route refactors. The label/route fields are advisory —
// they're what we render in the favorites drawer + Settings → Personalization
// today, but if a route moves under us, the menu_key stays stable so the
// user's pinned favorites do not break.
//
// Server-side mirror at api/_lib/menuKeys.js — duplicated as CommonJS so the
// PUT favorites + PUT home-route handlers can validate menu_key membership
// without pulling a TS file into the Vercel functions runtime.
//
// IMPORTANT — when adding a new menu item to any app:
//   1. Append a new MenuKey row here (don't reorder; existing rows keep their
//      position so diffs stay small).
//   2. Append the SAME menu_key string to api/_lib/menuKeys.js KEY_SET.
//   3. Bump the v: counter at the bottom of this file so we have an audit
//      trail of registry revisions (cosmetic but helpful when debugging).
// ════════════════════════════════════════════════════════════════════════════

export type AppId = "dc" | "ats" | "powip" | "gs1" | "tanda" | "techpack";

export interface MenuKey {
  key: string;            // stable, kebab-case, app-prefixed e.g. "tanda/journal-entries"
  label: string;          // human label as shown in nav
  app: AppId;             // owning app — drives the launcher card + grouping
  route: string;          // path to navigate to (incl. ?view= query)
  group?: string;         // nav group label (e.g. "Analytics & Admin")
  icon?: string;          // optional emoji / icon name
}

// ─── Design Calendar (DC) ──────────────────────────────────────────────────
// Header nav buttons in src/App.tsx around lines 565-630.
const DC_MENU: MenuKey[] = [
  { key: "dc/dashboard",     label: "Dashboard",     app: "dc", route: "/design",                  group: "Calendar" },
  { key: "dc/timeline",      label: "Timeline",      app: "dc", route: "/design?view=timeline",    group: "Calendar" },
  { key: "dc/calendar",      label: "Calendar",      app: "dc", route: "/design?view=calendar",    group: "Calendar" },
  { key: "dc/trend-briefs",  label: "Trend Briefs",  app: "dc", route: "/design?view=trend-briefs", group: "Calendar" },
  { key: "dc/teams",         label: "Teams",         app: "dc", route: "/design?view=teams",       group: "Communication", icon: "💬" },
  { key: "dc/email",         label: "Email",         app: "dc", route: "/design?view=email",       group: "Communication", icon: "📧" },
  { key: "dc/notifications", label: "Notifications", app: "dc", route: "/design?view=notifications", group: "Communication", icon: "🔔" },
];

// ─── ATS (Available to Sell) ───────────────────────────────────────────────
// ATS uses a single grid view but exposes its 3 viewMode pivots + the
// Reports menu as discrete personalizable destinations.
const ATS_MENU: MenuKey[] = [
  { key: "ats/grid",                 label: "ATS Grid",            app: "ats", route: "/ats",                  group: "Grid" },
  { key: "ats/grid-so",              label: "SO View",             app: "ats", route: "/ats?view=so",          group: "Grid" },
  { key: "ats/grid-po",              label: "PO View",             app: "ats", route: "/ats?view=po",          group: "Grid" },
  { key: "ats/reports/export-excel", label: "Export Excel",        app: "ats", route: "/ats?report=export",    group: "Reports" },
  { key: "ats/reports/neg-inven",    label: "Neg Inventory",       app: "ats", route: "/ats?report=neg-inven", group: "Reports" },
  { key: "ats/reports/aged-inven",   label: "Aged Inventory",      app: "ats", route: "/ats?report=aged-inven", group: "Reports" },
  { key: "ats/reports/no-mrgn",      label: "NO Margin Data",      app: "ats", route: "/ats?report=no-mrgn",   group: "Reports" },
  { key: "ats/reports/stock-vs-so",  label: "Stock vs SO",         app: "ats", route: "/ats?report=stock-vs-so", group: "Reports" },
  { key: "ats/reports/sales-comps",  label: "Sales Comps",         app: "ats", route: "/ats?report=sales-comps", group: "Reports" },
];

// ─── PO WIP (Tanda PO tracking app) ────────────────────────────────────────
// Top nav in src/TandA.tsx around lines 1471-1504 + the VENDOR_MENU groups
// (lines 125-171). PO WIP is the public-facing alias for the Tanda code.
const POWIP_MENU: MenuKey[] = [
  // Top-level nav
  { key: "powip/dashboard",     label: "Dashboard",     app: "powip", route: "/tanda?view=dashboard",     group: "Main", icon: "🏠" },
  { key: "powip/list",          label: "All POs",       app: "powip", route: "/tanda?view=list",          group: "Main" },
  { key: "powip/grid",          label: "Grid",          app: "powip", route: "/tanda?view=grid",          group: "Main", icon: "🗂" },
  { key: "powip/templates",     label: "Templates",     app: "powip", route: "/tanda?view=templates",     group: "Main", icon: "📐" },
  { key: "powip/teams",         label: "Teams",         app: "powip", route: "/tanda?view=teams",         group: "Main", icon: "💬" },
  { key: "powip/email",         label: "Email",         app: "powip", route: "/tanda?view=email",         group: "Main", icon: "📧" },
  { key: "powip/activity",      label: "Activity",      app: "powip", route: "/tanda?view=activity",      group: "Main", icon: "📋" },
  { key: "powip/timeline",      label: "Timeline",      app: "powip", route: "/tanda?view=timeline",      group: "Main", icon: "📊" },
  { key: "powip/archive",       label: "Archive",       app: "powip", route: "/tanda?view=archive",       group: "Main", icon: "📦" },
  { key: "powip/notifications", label: "Notifications", app: "powip", route: "/tanda?view=notifications", group: "Main", icon: "🔔" },

  // Vendors group (VENDOR_MENU_GROUPS in TandA.tsx)
  { key: "powip/vendors/directory",    label: "Directory",    app: "powip", route: "/tanda?view=vendors",            group: "Vendors", icon: "🏢" },
  { key: "powip/vendors/onboarding",   label: "Onboarding",   app: "powip", route: "/tanda?view=onboarding",         group: "Vendors", icon: "🚀" },
  { key: "powip/vendors/preferred",    label: "Preferred",    app: "powip", route: "/tanda?view=preferred_vendors",  group: "Vendors", icon: "⭐" },
  { key: "powip/vendors/scorecards",   label: "Scorecards",   app: "powip", route: "/tanda?view=scorecards",         group: "Vendors", icon: "🏆" },
  { key: "powip/vendors/health-scores", label: "Health Scores", app: "powip", route: "/tanda?view=health_scores",    group: "Vendors", icon: "❤️" },
  { key: "powip/vendors/diversity",    label: "Diversity",    app: "powip", route: "/tanda?view=diversity",          group: "Vendors", icon: "🤝" },
  { key: "powip/vendors/sustainability", label: "Sustainability", app: "powip", route: "/tanda?view=sustainability", group: "Vendors", icon: "🌱" },
  { key: "powip/vendors/esg-scores",   label: "ESG Scores",   app: "powip", route: "/tanda?view=esg_scores",         group: "Vendors", icon: "🌍" },

  // Operations group
  { key: "powip/ops/shipments",        label: "Shipments",    app: "powip", route: "/tanda?view=shipments",          group: "Operations", icon: "🚢" },
  { key: "powip/ops/match",            label: "3-Way Match",  app: "powip", route: "/tanda?view=match",              group: "Operations", icon: "🔍" },
  { key: "powip/ops/messages",         label: "Messages",     app: "powip", route: "/tanda?view=messages",           group: "Operations", icon: "💬" },
  { key: "powip/ops/phase-reviews",    label: "Phase Reviews", app: "powip", route: "/tanda?view=phase_reviews",     group: "Operations", icon: "🧭" },
  { key: "powip/ops/anomalies",        label: "Anomalies",    app: "powip", route: "/tanda?view=anomalies",          group: "Operations", icon: "🚨" },
  { key: "powip/ops/workspaces",       label: "Workspaces",   app: "powip", route: "/tanda?view=workspaces",         group: "Operations", icon: "🗂️" },

  // Compliance group
  { key: "powip/compliance/documents", label: "Compliance Documents", app: "powip", route: "/tanda?view=compliance",  group: "Compliance", icon: "📋" },
  { key: "powip/compliance/automation", label: "Compliance Automation", app: "powip", route: "/tanda?view=compliance_automation", group: "Compliance", icon: "🤖" },
  { key: "powip/compliance/audit",     label: "Compliance Audit",     app: "powip", route: "/tanda?view=compliance_audit", group: "Compliance", icon: "📜" },

  // Sourcing group
  { key: "powip/sourcing/rfqs",        label: "RFQs",         app: "powip", route: "/tanda?view=rfqs",               group: "Sourcing", icon: "📨" },
  { key: "powip/sourcing/marketplace", label: "Marketplace",  app: "powip", route: "/tanda?view=marketplace",        group: "Sourcing", icon: "🛍️" },
  { key: "powip/sourcing/marketplace-inquiries", label: "Marketplace Inquiries", app: "powip", route: "/tanda?view=marketplace_inquiries", group: "Sourcing", icon: "💬" },
  { key: "powip/sourcing/benchmark",   label: "Benchmark",    app: "powip", route: "/tanda?view=benchmark",          group: "Sourcing", icon: "📈" },
  { key: "powip/sourcing/insights",    label: "Insights",     app: "powip", route: "/tanda?view=insights",           group: "Sourcing", icon: "💡" },

  // Finance group
  { key: "powip/finance/payments",     label: "Payments",     app: "powip", route: "/tanda?view=payments",           group: "Finance", icon: "💸" },
  { key: "powip/finance/discount-offers", label: "Discount Offers", app: "powip", route: "/tanda?view=discount_offers", group: "Finance", icon: "⚡" },
  { key: "powip/finance/scf",          label: "Supply Chain Finance", app: "powip", route: "/tanda?view=scf",        group: "Finance", icon: "🏦" },
  { key: "powip/finance/virtual-cards", label: "Virtual Cards", app: "powip", route: "/tanda?view=virtual_cards",    group: "Finance", icon: "💳" },
  { key: "powip/finance/fx",           label: "FX",           app: "powip", route: "/tanda?view=fx",                 group: "Finance", icon: "🌐" },
  { key: "powip/finance/tax",          label: "Tax",          app: "powip", route: "/tanda?view=tax",                group: "Finance", icon: "🧾" },

  // Analytics & Admin group
  { key: "powip/admin/analytics",      label: "Analytics",    app: "powip", route: "/tanda?view=analytics",          group: "Analytics & Admin", icon: "📊" },
  { key: "powip/admin/spend",          label: "Spend",        app: "powip", route: "/tanda?view=spend",              group: "Analytics & Admin", icon: "💰" },
  { key: "powip/admin/workflow-rules", label: "Workflow Rules", app: "powip", route: "/tanda?view=workflow_rules",   group: "Analytics & Admin", icon: "⚙️" },
  { key: "powip/admin/workflow-executions", label: "Approvals", app: "powip", route: "/tanda?view=workflow_executions", group: "Analytics & Admin", icon: "✅" },
  { key: "powip/admin/entities",       label: "Entities",     app: "powip", route: "/tanda?view=entities",           group: "Analytics & Admin", icon: "🏛️" },
];

// ─── GS1 Prepack Labels ────────────────────────────────────────────────────
// TABS list in src/gs1/panels/NavBar.tsx lines 7-19.
const GS1_MENU: MenuKey[] = [
  { key: "gs1/company",       label: "Company Setup",     app: "gs1", route: "/gs1?tab=company",       group: "Setup" },
  { key: "gs1/upc",           label: "UPC Master",        app: "gs1", route: "/gs1?tab=upc",           group: "Masters" },
  { key: "gs1/scale",         label: "Scale Master",      app: "gs1", route: "/gs1?tab=scale",         group: "Masters" },
  { key: "gs1/gtins",         label: "Pack GTINs",        app: "gs1", route: "/gs1?tab=gtins",         group: "Masters" },
  { key: "gs1/catalog",       label: "Styles Catalog",    app: "gs1", route: "/gs1?tab=catalog",       group: "Catalog" },
  { key: "gs1/upload",        label: "Packing List",      app: "gs1", route: "/gs1?tab=upload",        group: "Workflow" },
  { key: "gs1/pa-unpacker",   label: "PA Unpacker",       app: "gs1", route: "/gs1?tab=pa_unpacker",   group: "Workflow" },
  { key: "gs1/labels",        label: "Label Batches",     app: "gs1", route: "/gs1?tab=labels",        group: "Labels" },
  { key: "gs1/templates",     label: "Label Templates",   app: "gs1", route: "/gs1?tab=templates",     group: "Labels" },
  { key: "gs1/cartons",       label: "Carton Labels",     app: "gs1", route: "/gs1?tab=cartons",       group: "Labels" },
  { key: "gs1/receiving",     label: "Receiving",         app: "gs1", route: "/gs1?tab=receiving",     group: "Workflow" },
  { key: "gs1/exceptions",    label: "Exceptions",        app: "gs1", route: "/gs1?tab=exceptions",    group: "Workflow" },
  { key: "gs1/edi-workflow",  label: "Workflow Guide",    app: "gs1", route: "/gs1?tab=edi_workflow",  group: "Help" },
  { key: "gs1/notifications", label: "Notifications",     app: "gs1", route: "/gs1?tab=notifications", group: "Communication", icon: "🔔" },
];

// ─── Tanda / Tangerine ERP modules ─────────────────────────────────────────
// MODULES list in src/Tangerine.tsx lines 161-220. Same shell hosts every
// Tangerine internal panel (style master through shadow mirror).
//
// IMPORTANT — these modules are rendered by the *Tangerine* shell (src/main.tsx
// routes `/tangerine` → Tangerine.tsx), which selects its active module from
// `?m=<moduleKey>`. They are NOT TandA (PO-WIP) views — TandA is served at
// `/tanda` and reads `?view=`. So every route below points at the Tangerine
// shell with `?m=<moduleKey>`; the moduleKey matches Tangerine's ModuleKey
// union exactly. (Item 13 bug fix: these used to point at `/tanda?view=…`,
// which dropped the operator into the wrong shell when reopening a favorite.)
//
// The `key` strings are unchanged (the `tanda/…` prefix is a historical name
// that survives label/route refactors) so api/_lib/menuKeys.js MENU_KEY_SET
// stays in sync — only the `route` field moves here.
const TANDA_MENU: MenuKey[] = [
  // Master Data
  { key: "tanda/master/style",         label: "Style Master",       app: "tanda", route: "/tangerine?m=style_master",     group: "Master Data", icon: "🎨" },
  { key: "tanda/master/pim-catalog",   label: "Product Catalog Master",    app: "tanda", route: "/tangerine?m=pim_catalog",      group: "Master Data", icon: "🏷️" },
  { key: "tanda/master/fabric-codes",  label: "Fabric Codes Master",       app: "tanda", route: "/tangerine?m=fabric_codes",     group: "Master Data", icon: "🧵" },
  { key: "tanda/master/vendor",        label: "Vendor Master",      app: "tanda", route: "/tangerine?m=vendor_master",    group: "Master Data", icon: "🏭" },
  { key: "tanda/master/customer",      label: "Customer Master",    app: "tanda", route: "/tangerine?m=customer_master",  group: "Master Data", icon: "🤝" },
  { key: "tanda/master/payment-terms", label: "Payment Terms Master",      app: "tanda", route: "/tangerine?m=payment_terms",    group: "Master Data", icon: "📆" },
  { key: "tanda/master/countries",     label: "Countries Master",          app: "tanda", route: "/tangerine?m=countries",        group: "Master Data", icon: "🌍" },
  { key: "tanda/master/genders",       label: "Genders Master",            app: "tanda", route: "/tangerine?m=genders",          group: "Master Data", icon: "⚧" },
  { key: "tanda/master/style-classifications", label: "Group/Category/Sub Master", app: "tanda", route: "/tangerine?m=style_classifications", group: "Master Data", icon: "🗂️" },
  { key: "tanda/master/factors",       label: "Factors/Insurance Master",  app: "tanda", route: "/tangerine?m=factors",          group: "Master Data", icon: "🏦" },
  { key: "tanda/master/size-scales",   label: "Size Scales Master",        app: "tanda", route: "/tangerine?m=size_scales",      group: "Master Data", icon: "📏" },
  { key: "tanda/master/seasons",       label: "Seasons Master",            app: "tanda", route: "/tangerine?m=season_master",    group: "Master Data", icon: "🍂" },
  { key: "tanda/master/colors",        label: "Color Master",              app: "tanda", route: "/tangerine?m=color_master",     group: "Master Data", icon: "🎨" },
  { key: "tanda/master/rma-reasons",   label: "RMA Reasons Master",        app: "tanda", route: "/tangerine?m=rma_reason_master", group: "Master Data", icon: "↩️" },
  { key: "tanda/master/adjustment-types", label: "Adjustment Types Master", app: "tanda", route: "/tangerine?m=adjustment_type_master", group: "Master Data", icon: "⚙️" },
  { key: "tanda/master/adjustment-reasons", label: "Adjustment Reason Master", app: "tanda", route: "/tangerine?m=adjustment_reason_master", group: "Master Data", icon: "📋" },
  { key: "tanda/master/transfer-reasons", label: "Transfer Reasons Master", app: "tanda", route: "/tangerine?m=transfer_reason_master", group: "Master Data", icon: "🔁" },
  { key: "tanda/master/date-presets", label: "Date Presets Master", app: "tanda", route: "/tangerine?m=date_preset_master", group: "Master Data", icon: "📅" },
  { key: "tanda/master/warehouses",    label: "Warehouses Master",         app: "tanda", route: "/tangerine?m=warehouse_master",  group: "Master Data", icon: "🏬" },
  { key: "tanda/master/hts-master",   label: "HTS Master",                app: "tanda", route: "/tangerine?m=hts_master",        group: "Master Data", icon: "🛃" },
  { key: "tanda/master/fabric-mills", label: "Fabric Mill Master",        app: "tanda", route: "/tangerine?m=fabric_mill_master", group: "Master Data", icon: "🏭" },
  { key: "tanda/master/part-master",  label: "Part Master",               app: "tanda", route: "/tangerine?m=part_master",       group: "Master Data", icon: "🧩" },
  { key: "tanda/master/service-items", label: "Service Item Master",      app: "tanda", route: "/tangerine?m=service_item_master", group: "Master Data", icon: "🛠️" },
  { key: "tanda/master/part-types",   label: "Part Type Master",          app: "tanda", route: "/tangerine?m=part_type_master", group: "Master Data", icon: "🏷️" },
  { key: "tanda/mfg/part-inventory",  label: "Part Inventory",            app: "tanda", route: "/tangerine?m=part_inventory",    group: "Manufacturing", icon: "🧩" },
  { key: "tanda/mfg/boms",            label: "Bill of Materials",         app: "tanda", route: "/tangerine?m=mfg_bom",          group: "Manufacturing", icon: "📋" },
  { key: "tanda/mfg/build-orders",    label: "Build Orders",              app: "tanda", route: "/tangerine?m=mfg_build_orders", group: "Manufacturing", icon: "🛠️" },
  { key: "tanda/mfg/reports",         label: "Mfg Reports",               app: "tanda", route: "/tangerine?m=mfg_reports",      group: "Manufacturing", icon: "📊" },
  { key: "tanda/master/carriers",     label: "Carrier Master",            app: "tanda", route: "/tangerine?m=carrier_master",     group: "Master Data", icon: "🚚" },
  { key: "tanda/master/buyer-scopes", label: "Buyer Scope Master",        app: "tanda", route: "/tangerine?m=buyer_scope_master", group: "Master Data", icon: "🛒" },
  // P18-F — internal B2B admin (buyers + wholesale price list).
  { key: "tanda/b2b/accounts",         label: "B2B Buyers",         app: "tanda", route: "/tangerine?m=b2b_accounts",     group: "Customers", icon: "🛍️" },
  { key: "tanda/b2b/price-list",       label: "Price Lists",        app: "tanda", route: "/tangerine?m=b2b_price_list",   group: "Pricing", icon: "🏷️" },
  { key: "tanda/pricing/promotions",   label: "Promotions",         app: "tanda", route: "/tangerine?m=pricing_promotions", group: "Pricing", icon: "🎁" },
  // Accounting
  { key: "tanda/accounting/coa",        label: "Chart of Accounts", app: "tanda", route: "/tangerine?m=gl_accounts",       group: "Accounting", icon: "📒" },
  { key: "tanda/accounting/periods",    label: "Periods",           app: "tanda", route: "/tangerine?m=gl_periods",        group: "Accounting", icon: "🗓️" },
  { key: "tanda/accounting/journal-entries", label: "Journal Entries", app: "tanda", route: "/tangerine?m=journal_entries", group: "Accounting", icon: "📓" },
  { key: "tanda/accounting/ap-invoices", label: "AP Invoices",      app: "tanda", route: "/tangerine?m=ap_invoices",       group: "Accounting", icon: "🧾" },
  { key: "tanda/accounting/ap-payments", label: "AP Payments",      app: "tanda", route: "/tangerine?m=ap_payments",       group: "Accounting", icon: "💸" },
  { key: "tanda/accounting/ar-invoices", label: "AR Invoices",      app: "tanda", route: "/tangerine?m=ar_invoices",       group: "Customers – Accts Rec", icon: "🧮" },
  { key: "tanda/sales/sales-orders",  label: "Sales Orders",        app: "tanda", route: "/tangerine?m=sales_orders",      group: "Sales", icon: "🛒" },
  { key: "tanda/sales/allocations",   label: "Allocations",         app: "tanda", route: "/tangerine?m=sales_allocations", group: "Sales", icon: "📊" },
  { key: "tanda/sales/returns-rma",   label: "Returns/RMA",         app: "tanda", route: "/tangerine?m=sales_returns",     group: "Sales", icon: "↩️" },
  { key: "tanda/sales/drop-ship",     label: "Drop-Ship",           app: "tanda", route: "/tangerine?m=drop_ship",         group: "Sales", icon: "📦" },
  { key: "tanda/accounting/ar-receipts", label: "AR Receipts",      app: "tanda", route: "/tangerine?m=ar_receipts",       group: "Customers – Accts Rec", icon: "💵" },
  { key: "tanda/accounting/ar-aging",   label: "AR Aging",          app: "tanda", route: "/tangerine?m=ar_aging",          group: "Customers – Accts Rec", icon: "📅" },
  { key: "tanda/accounting/ar-backfill", label: "AR Backfill",      app: "tanda", route: "/tangerine?m=ar_backfill",       group: "Customers – Accts Rec", icon: "🗄️" },
  { key: "tanda/accounting/trial-balance", label: "Trial Balance",  app: "tanda", route: "/tangerine?m=trial_balance",     group: "Accounting", icon: "📊" },
  { key: "tanda/accounting/income-statement", label: "Income Statement", app: "tanda", route: "/tangerine?m=income_statement", group: "Accounting", icon: "📈" },
  { key: "tanda/accounting/segment-pl", label: "Segment P&L",     app: "tanda", route: "/tangerine?m=segment_pl",        group: "Accounting", icon: "📈" },
  { key: "tanda/accounting/balance-sheet", label: "Balance Sheet",  app: "tanda", route: "/tangerine?m=balance_sheet",     group: "Accounting", icon: "📋" },
  { key: "tanda/accounting/cash-flow",  label: "Cash Flow",         app: "tanda", route: "/tangerine?m=cash_flow",         group: "Accounting", icon: "💧" },
  { key: "tanda/accounting/year-end-close", label: "Year-End Close", app: "tanda", route: "/tangerine?m=year_end_close",   group: "Accounting", icon: "🔚" },
  { key: "tanda/accounting/fixed-assets", label: "Fixed Assets",     app: "tanda", route: "/tangerine?m=fixed_assets",      group: "Accounting", icon: "🏢" },
  { key: "tanda/accounting/budgets",      label: "Budgets",           app: "tanda", route: "/tangerine?m=budgets",           group: "Accounting", icon: "🎯" },
  { key: "tanda/accounting/form-1099",    label: "1099 Worksheet",    app: "tanda", route: "/tangerine?m=form_1099",         group: "Accounting", icon: "🧾" },
  { key: "tanda/accounting/bank-reconciliation", label: "Bank Reconciliation", app: "tanda", route: "/tangerine?m=bank_reconciliation", group: "Accounting", icon: "🏦" },
  // CRM
  { key: "tanda/crm/opportunities",     label: "CRM Opportunities", app: "tanda", route: "/tangerine?m=crm_opportunities", group: "CRM", icon: "💼" },
  { key: "tanda/crm/activities",        label: "CRM Activities",    app: "tanda", route: "/tangerine?m=crm_activities",    group: "CRM", icon: "📋" },
  { key: "tanda/crm/tasks",             label: "CRM Tasks",         app: "tanda", route: "/tangerine?m=crm_tasks",         group: "CRM", icon: "✅" },
  { key: "tanda/crm/pipeline-report",   label: "Pipeline Report",   app: "tanda", route: "/tangerine?m=crm_pipeline_report", group: "CRM", icon: "📊" },
  // Reports
  { key: "tanda/reports/ap-aging",      label: "AP Aging",          app: "tanda", route: "/tangerine?m=ap_aging",          group: "Reports", icon: "📅" },
  // Nav reorg: Sales by Rep moved to the Sales section; Sales by Customer to Customers.
  { key: "tanda/reports/sales-by-rep",  label: "Sales by Rep",      app: "tanda", route: "/tangerine?m=sales_by_rep",      group: "Sales", icon: "🧑‍💼" },
  { key: "tanda/reports/sales-by-customer", label: "Sales by Customer", app: "tanda", route: "/tangerine?m=sales_by_customer", group: "Customers", icon: "🤝" },
  { key: "tanda/reports/hub",           label: "Reports & Analytics", app: "tanda", route: "/tangerine?m=reports_hub",      group: "Reports", icon: "📊" },
  { key: "tanda/reports/gl-detail",     label: "GL Detail",         app: "tanda", route: "/tangerine?m=gl_detail",         group: "Reports", icon: "🔍" },
  { key: "tanda/reports/upc-report",    label: "UPC Report",        app: "tanda", route: "/tangerine?m=upc_report",        group: "Reports", icon: "🔖" },
  // Scorecards — nav-reachable entry points under Vendors / Customers.
  { key: "tanda/vendors/scorecard",     label: "Vendor Scorecard",   app: "tanda", route: "/tangerine?m=vendor_scorecard",   group: "Vendors", icon: "📊" },
  { key: "tanda/customers/scorecard",   label: "Customer Scorecard", app: "tanda", route: "/tangerine?m=customer_scorecard", group: "Customers", icon: "📊" },
  // Inventory
  { key: "tanda/procurement/purchase-orders", label: "Purchase Orders", app: "tanda", route: "/tangerine?m=purchase_orders", group: "Procurement", icon: "📦" },
  { key: "tanda/procurement/receiving", label: "Receiving", app: "tanda", route: "/tangerine?m=receiving", group: "Procurement", icon: "📥" },
  { key: "tanda/procurement/bookkeeper-approval", label: "Bookkeeper Approval", app: "tanda", route: "/tangerine?m=bookkeeper_approval", group: "Procurement", icon: "🧾" },
  { key: "tanda/procurement/qc", label: "QC Inspections", app: "tanda", route: "/tangerine?m=qc_inspections", group: "Procurement", icon: "🔍" },
  { key: "tanda/procurement/customs", label: "Customs Entries", app: "tanda", route: "/tangerine?m=customs_entries", group: "Procurement", icon: "🛃" },
  { key: "tanda/procurement/broker-invoices", label: "Broker Invoices", app: "tanda", route: "/tangerine?m=broker_invoices", group: "Procurement", icon: "🚢" },
  { key: "tanda/procurement/three-way-match", label: "3-Way Match", app: "tanda", route: "/tangerine?m=three_way_match", group: "Procurement", icon: "⚖️" },
  { key: "tanda/procurement/recon", label: "Procurement Recon", app: "tanda", route: "/tangerine?m=procurement_recon", group: "Procurement", icon: "🧮" },
  // EDI restructured into a Master-Data sub-menu: Vendors / Customers / Settings.
  // The existing vendor X12 panel keeps route m=edi, relabelled "Vendors".
  { key: "tanda/edi/vendors",   label: "EDI Vendors",   app: "tanda", route: "/tangerine?m=edi",           group: "EDI", icon: "🏭" },
  { key: "tanda/edi/customers", label: "EDI Customers", app: "tanda", route: "/tangerine?m=edi_customers", group: "EDI", icon: "🤝" },
  { key: "tanda/edi/settings",  label: "EDI Settings",  app: "tanda", route: "/tangerine?m=edi_settings",  group: "EDI", icon: "⚙️" },
  { key: "tanda/inventory/matrix",       label: "Inventory Matrix",  app: "tanda", route: "/tangerine?m=inventory_matrix",   group: "Inventory", icon: "🧮" },
  { key: "tanda/inventory/prepack-matrices", label: "Prepack Matrices Master", app: "tanda", route: "/tangerine?m=prepack_matrices", group: "Master Data", icon: "📦" },
  { key: "tanda/inventory/3pl",          label: "3PL",               app: "tanda", route: "/tangerine?m=three_pl",          group: "Inventory", icon: "🚚" },
  { key: "tanda/inventory/3pl-recon",    label: "3PL Inventory Recon", app: "tanda", route: "/tangerine?m=three_pl_recon",  group: "Inventory", icon: "📋" },
  { key: "tanda/inventory/transfers",   label: "Inventory Transfers", app: "tanda", route: "/tangerine?m=inventory_transfers", group: "Inventory", icon: "🔁" },
  { key: "tanda/inventory/adjustments", label: "Inventory Adjustments", app: "tanda", route: "/tangerine?m=inventory_adjustments", group: "Inventory", icon: "📐" },
  { key: "tanda/inventory/cycle-counts", label: "Cycle Counts",     app: "tanda", route: "/tangerine?m=cycle_counts",      group: "Inventory", icon: "📋" },
  // Customer Service
  { key: "tanda/cs/cases",              label: "Cases",             app: "tanda", route: "/tangerine?m=cases",             group: "Customer Service", icon: "🎫" },
  // Shadow Mirror
  { key: "tanda/shadow-mirror/status",  label: "Mirror Status",     app: "tanda", route: "/tangerine?m=shadow_mirror",     group: "Shadow Mirror", icon: "🔁" },
  // Approvals
  { key: "tanda/approvals/rules",       label: "Approval Rules",    app: "tanda", route: "/tangerine?m=approval_rules",    group: "Approvals", icon: "⚙️" },
  { key: "tanda/approvals/inbox",       label: "Approval Inbox",    app: "tanda", route: "/tangerine?m=approval_requests", group: "Approvals", icon: "✅" },
  // Notifications
  { key: "tanda/notifications/center",  label: "Notification Center", app: "tanda", route: "/tangerine?m=notifications",   group: "Notifications", icon: "🔔" },
  { key: "tanda/notifications/prefs",   label: "Notification Preferences", app: "tanda", route: "/tangerine?m=notification_prefs", group: "Notifications", icon: "🎚️" },
  // HR
  { key: "tanda/hr/employees",          label: "Employees",         app: "tanda", route: "/tangerine?m=employees",         group: "HR", icon: "👥" },
  { key: "tanda/hr/employee-titles",       label: "Employee Titles",      app: "tanda", route: "/tangerine?m=employee_titles",      group: "HR", icon: "🏷️" },
  { key: "tanda/hr/employee-departments",  label: "Employee Departments", app: "tanda", route: "/tangerine?m=employee_departments", group: "HR", icon: "🏢" },
  // Operations
  { key: "tanda/operations/scanner-sessions", label: "Scanner Sessions", app: "tanda", route: "/tangerine?m=scanner_sessions", group: "Operations", icon: "📱" },
  // Registry-gap backfill — nav-reachable Tangerine modules that were missing
  // a menu_key (favorites/home-route could not pin them). Group/label mirror
  // their ModuleDef in src/Tangerine.tsx.
  { key: "tanda/accounting/recon-report",       label: "Recon Report",         app: "tanda", route: "/tangerine?m=bank_recon_report",  group: "Accounting", icon: "⚖️" },
  { key: "tanda/accounting/commission-accruals", label: "Commission Accruals", app: "tanda", route: "/tangerine?m=commission_accruals", group: "Accounting", icon: "💰" },
  { key: "tanda/accounting/commission-payouts",  label: "Commission Payouts",  app: "tanda", route: "/tangerine?m=commission_payouts",  group: "Accounting", icon: "📜" },
  // Factor Module Phase 1 — Rosenthal statements + open-AR + GL 1107 tie-out.
  { key: "tanda/accounting/factor-recon",        label: "Factor (Rosenthal)",   app: "tanda", route: "/tangerine?m=factor_recon",        group: "Accounting", icon: "🏦" },
  // Chargeback Management — matched-invoice worklist + disposition workflow + dilution.
  { key: "tanda/accounting/chargebacks",         label: "Chargebacks",          app: "tanda", route: "/tangerine?m=chargebacks",         group: "Accounting", icon: "🧾" },
  // Month-End Close — per-period checklist (auto tie-outs + sign-offs) + period locking.
  { key: "tanda/accounting/month-end-close",     label: "Month-End Close",      app: "tanda", route: "/tangerine?m=month_end_close",     group: "Accounting", icon: "🔒" },
  { key: "tanda/shopify/refunds",                label: "Refunds",              app: "tanda", route: "/tangerine?m=shopify_refunds",     group: "Shopify", icon: "↩️" },
  { key: "tanda/shopify/stores",                 label: "Connect Store",        app: "tanda", route: "/tangerine?m=shopify_stores",     group: "Shopify", icon: "🛍️" },
  { key: "tanda/marketplaces/status",            label: "Marketplace Status",   app: "tanda", route: "/tangerine?m=marketplace_status",  group: "Marketplaces", icon: "🛒" },
  { key: "tanda/audit/log",                      label: "Audit Log",            app: "tanda", route: "/tangerine?m=audit_log",           group: "Audit", icon: "🕒" },
  { key: "tanda/admin/user-access",              label: "User Access",          app: "tanda", route: "/tangerine?m=user_access",         group: "Admin", icon: "🔐" },
  // #983 — surface 26 built-but-unmenued Tangerine panels.
  // Treasury group.
  { key: "tanda/treasury/payments",          label: "Payments",            app: "tanda", route: "/tangerine?m=payments",          group: "Treasury", icon: "💸" },
  { key: "tanda/treasury/reconciliation",    label: "Reconciliation",      app: "tanda", route: "/tangerine?m=recon_dashboard",   group: "Treasury", icon: "⚖️" },
  { key: "tanda/treasury/fx",                label: "FX",                  app: "tanda", route: "/tangerine?m=fx",                group: "Treasury", icon: "🌐" },
  { key: "tanda/treasury/virtual-cards",     label: "Virtual Cards",       app: "tanda", route: "/tangerine?m=virtual_cards",     group: "Treasury", icon: "💳" },
  { key: "tanda/treasury/scf",               label: "Supply Chain Finance", app: "tanda", route: "/tangerine?m=scf",              group: "Treasury", icon: "🏦" },
  { key: "tanda/treasury/discount-offers",   label: "Discount Offers",     app: "tanda", route: "/tangerine?m=discount_offers",   group: "Treasury", icon: "⚡" },
  { key: "tanda/treasury/tax",               label: "Tax",                 app: "tanda", route: "/tangerine?m=tax",               group: "Treasury", icon: "🧾" },
  // Procurement RFQs.
  { key: "tanda/procurement/rfqs",           label: "RFQs",                app: "tanda", route: "/tangerine?m=rfqs",              group: "Procurement", icon: "📨" },
  // Reports analytics.
  { key: "tanda/reports/analytics",          label: "Analytics",           app: "tanda", route: "/tangerine?m=analytics",         group: "Reports", icon: "📊" },
  { key: "tanda/reports/insights",           label: "Insights",            app: "tanda", route: "/tangerine?m=insights",          group: "Reports", icon: "💡" },
  { key: "tanda/reports/anomalies",          label: "Anomalies",           app: "tanda", route: "/tangerine?m=anomalies",         group: "Reports", icon: "🚨" },
  { key: "tanda/reports/benchmark",          label: "Benchmark",           app: "tanda", route: "/tangerine?m=benchmark",         group: "Reports", icon: "📈" },
  { key: "tanda/reports/health-scores",      label: "Vendor Health",       app: "tanda", route: "/tangerine?m=health_scores",     group: "Vendors", icon: "❤️" },
  { key: "tanda/reports/preferred",          label: "Preferred Vendors",   app: "tanda", route: "/tangerine?m=preferred",         group: "Reports", icon: "⭐" },
  // ESG & Compliance group.
  { key: "tanda/esg/sustainability",         label: "Sustainability",      app: "tanda", route: "/tangerine?m=sustainability",    group: "ESG & Compliance", icon: "🌿" },
  { key: "tanda/esg/esg-scores",             label: "ESG Scores",          app: "tanda", route: "/tangerine?m=esg_scores",        group: "ESG & Compliance", icon: "🌍" },
  { key: "tanda/esg/diversity",              label: "Diversity",           app: "tanda", route: "/tangerine?m=diversity",         group: "ESG & Compliance", icon: "🤲" },
  { key: "tanda/esg/compliance-audit",       label: "Compliance Audit",    app: "tanda", route: "/tangerine?m=compliance_audit",  group: "ESG & Compliance", icon: "📜" },
  { key: "tanda/esg/compliance-automation",  label: "Compliance Automation", app: "tanda", route: "/tangerine?m=compliance_automation", group: "ESG & Compliance", icon: "🤖" },
  // Workflow group.
  { key: "tanda/workflow/rules",             label: "Workflow Rules",      app: "tanda", route: "/tangerine?m=workflow_rules",    group: "Workflow", icon: "🧩" },
  { key: "tanda/workflow/executions",        label: "Approvals Queue",     app: "tanda", route: "/tangerine?m=workflow_executions", group: "Workflow", icon: "🗳️" },
  { key: "tanda/workflow/workspaces",        label: "Workspaces",          app: "tanda", route: "/tangerine?m=workspaces",        group: "Workflow", icon: "🗂️" },
  // Marketplaces.
  { key: "tanda/marketplaces/marketplace",   label: "Marketplace",         app: "tanda", route: "/tangerine?m=marketplace",      group: "Marketplaces", icon: "🛍️" },
  { key: "tanda/marketplaces/inquiries",     label: "Marketplace Inquiries", app: "tanda", route: "/tangerine?m=marketplace_inquiries", group: "Marketplaces", icon: "📩" },
  // Admin.
  { key: "tanda/admin/entities",             label: "Entities",            app: "tanda", route: "/tangerine?m=entities",          group: "Admin", icon: "🏛️" },
  { key: "tanda/admin/onboarding",           label: "Onboarding",          app: "tanda", route: "/tangerine?m=onboarding",        group: "Admin", icon: "🚀" },
  { key: "tanda/admin/api-keys",             label: "API Keys",            app: "tanda", route: "/tangerine?m=api_keys",         group: "Admin", icon: "🔑" },
  { key: "tanda/admin/sync-health",          label: "Sync Health",         app: "tanda", route: "/tangerine?m=sync_health",      group: "Admin", icon: "🩺" },
];

// ─── Tech Packs ────────────────────────────────────────────────────────────
// Top nav in src/TechPack.tsx around lines 1442-1485. T4-5 (close-out) added
// these so the favorites drawer + click telemetry cover the Tech Pack shell
// too. `detail` is intentionally excluded — it's an instance view reached by
// clicking a row, not a discoverable nav destination.
const TECHPACK_MENU: MenuKey[] = [
  { key: "techpack/dashboard",     label: "Dashboard",     app: "techpack", route: "/techpack",               group: "Main",          icon: "🏠" },
  { key: "techpack/list",          label: "All Packs",     app: "techpack", route: "/techpack?view=list",     group: "Main",          icon: "📦" },
  { key: "techpack/libraries",     label: "Libraries",     app: "techpack", route: "/techpack?view=libraries", group: "Main",          icon: "📚" },
  { key: "techpack/samples",       label: "Samples",       app: "techpack", route: "/techpack?view=samples",  group: "Main",          icon: "🧵" },
  { key: "techpack/teams",         label: "Teams",         app: "techpack", route: "/techpack?view=teams",    group: "Communication", icon: "💬" },
  { key: "techpack/email",         label: "Email",         app: "techpack", route: "/techpack?view=email",    group: "Communication", icon: "📧" },
  { key: "techpack/notifications", label: "Notifications", app: "techpack", route: "/techpack?view=notifications", group: "Communication", icon: "🔔" },
];

// ─── Exports ───────────────────────────────────────────────────────────────

export const MENU_KEYS: MenuKey[] = [
  ...DC_MENU,
  ...ATS_MENU,
  ...POWIP_MENU,
  ...GS1_MENU,
  ...TANDA_MENU,
  ...TECHPACK_MENU,
];

// O(1) lookup by key. Frozen at module load.
export const MENU_KEY_BY_KEY: Record<string, MenuKey> = Object.freeze(
  MENU_KEYS.reduce<Record<string, MenuKey>>((acc, m) => {
    if (acc[m.key]) {
      // Loud failure during dev/test — duplicate keys would silently break
      // the deduped favorites/home_route lookup.
      throw new Error(`menuKeys.ts: duplicate menu_key "${m.key}"`);
    }
    acc[m.key] = m;
    return acc;
  }, {}),
);

/** Returns true if `key` is a known menu_key. */
export function isKnownMenuKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(MENU_KEY_BY_KEY, key);
}

/** All menu items belonging to a single app, in registry order. */
export function menuKeysForApp(app: AppId): MenuKey[] {
  return MENU_KEYS.filter((m) => m.app === app);
}

// Registry version. Bump when MENU_KEYS materially changes — UI can show
// "personalization registry vN" in Settings → Personalization for debugging.
export const MENU_KEYS_VERSION = 22;
