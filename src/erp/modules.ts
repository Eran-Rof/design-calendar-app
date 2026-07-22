// src/erp/modules.ts — Tangerine module registry + nav taxonomy.
// Extracted from Tangerine.tsx; pure data/types (no React, no panel imports).
// The shell (Tangerine.tsx) imports these for routing, nav, and home landing.
// ─────────────────────────────────────────────────────────────────────────────
// Tangerine modules — the 6 admin panels shipped in P1 Chunks 7/7b/7c/8a/8b/8c
// ─────────────────────────────────────────────────────────────────────────────
export type ModuleKey =
  // P28-1-2 — the assistant-first Today landing page (arch §5).
  | "today"
  | "style_master"
  | "pim_catalog"
  | "fabric_codes"
  | "vendor_master"
  | "customer_master"
  | "payment_terms"
  // Chunk I — reference master panels.
  | "countries"
  | "genders"
  | "style_classifications"
  | "factors"
  | "size_scales"
  | "season_master"
  | "color_master"
  | "fabric_mill_master"
  | "part_master"
  | "service_item_master"
  | "part_type_master"
  | "part_inventory"
  | "mfg_bom"
  | "mfg_build_orders"
  | "mfg_reports"
  | "sync_health"
  | "cutover_recon"
  | "rma_reason_master"
  | "adjustment_type_master"
  | "adjustment_reason_master"
  | "transfer_reason_master"
  | "date_preset_master"
  | "warehouse_master"
  | "carrier_master"
  | "buyer_scope_master"
  | "hts_master"
  // P18-F — internal B2B admin (buyers + wholesale price list).
  | "b2b_accounts"
  | "b2b_price_list"
  | "pricing_promotions"
  | "gl_accounts"
  | "gl_periods"
  | "journal_entries"
  | "ap_invoices"
  | "ap_payments"
  | "ar_invoices"
  | "ar_receipts"
  | "sales_orders"
  | "sales_allocations"
  | "sales_returns"
  | "drop_ship"
  | "three_pl"
  | "three_pl_recon"
  | "edi"
  | "edi_customers"
  | "edi_settings"
  | "reports_hub"
  | "upc_report"
  | "fixed_assets"
  | "budgets"
  | "form_1099"
  | "sales_tax"
  | "ar_aging"
  | "ar_collections"
  | "ar_backfill"
  | "trial_balance"
  | "income_statement"
  | "segment_pl"
  | "balance_sheet"
  | "consolidation"
  | "cash_flow"
  | "year_end_close"
  | "bank_reconciliation"
  | "bank_recon_report"
  | "factor_recon"
  | "chargebacks"
  | "month_end_close"
  | "xoro_recon"
  | "approval_rules"
  | "approval_requests"
  | "notifications"
  | "notification_prefs"
  | "employees"
  | "employee_titles"
  | "employee_departments"
  | "inventory_matrix"
  | "prepack_matrices"
  | "purchase_orders"
  | "receiving"
  | "bookkeeper_approval"
  | "qc_inspections"
  | "customs_entries"
  | "broker_invoices"
  | "three_way_match"
  | "procurement_recon"
  | "inventory_transfers"
  | "inventory_adjustments"
  | "inventory_accuracy"
  | "inventory_aging"
  | "cycle_counts"
  | "scanner_sessions"
  | "cases"
  // P7-7 — M9-subset reports under the new 📊 Reports group.
  | "ap_aging"
  | "sales_by_rep"
  | "sales_by_customer"
  | "gl_detail"
  // P8-3 — M25 CRM under new 🤝 CRM nav group.
  | "crm_opportunities"
  | "crm_activities"
  | "crm_tasks"
  | "crm_pipeline_report"
  // Cross-cutter T10-7 — Shadow Mirror Status (Xoro → Tangerine nightly mirror).
  | "shadow_mirror"
  // P11-7 — Shopify Refunds reports panel.
  | "shopify_refunds"
  // P11 — Connect Shopify Store.
  | "shopify_stores"
  // Tangerine P12-99 — Marketplaces status (Shopify / FBA / Walmart / Faire).
  | "marketplace_status"
  // Cross-cutter T11-3 — Universal audit log admin panel (🕒 Audit).
  | "audit_log"
  | "vendor_scorecard"
  | "customer_scorecard"
  | "commission_accruals"
  | "commission_payouts"
  // P14-3b — RBAC User Access admin panel (🔐 Admin).
  | "user_access"
  // #983 — Treasury group.
  | "payments"
  | "recon_dashboard"
  | "fx"
  | "virtual_cards"
  | "scf"
  | "discount_offers"
  | "tax"
  // #983 — Procurement.
  | "rfqs"
  // #983 — Reports analytics.
  | "analytics"
  | "insights"
  | "anomalies"
  | "benchmark"
  | "health_scores"
  | "preferred"
  // #983 — ESG & Compliance group.
  | "sustainability"
  | "esg_scores"
  | "diversity"
  | "compliance_audit"
  | "compliance_automation"
  // #983 — Workflow group.
  | "workflow_rules"
  | "workflow_executions"
  | "workspaces"
  // #983 — Marketplaces.
  | "marketplace"
  | "marketplace_inquiries"
  // #983 — Admin.
  | "entities"
  | "onboarding"
  // M15 — External / Partner API key admin.
  | "api_keys";

export type GroupKey = "Today" | "Master Data" | "EDI" | "Accounting" | "Treasury" | "Vendors" | "Procurement" | "Sales" | "Pricing" | "CRM" | "Customers" | "Customers – Accts Rec" | "Reports" | "ESG & Compliance" | "Workflow" | "Approvals" | "Notifications" | "HR" | "Inventory" | "Manufacturing" | "Customer Service" | "Shadow Mirror" | "Shopify" | "Marketplaces" | "Audit" | "Admin";

export type ModuleDef = {
  key: ModuleKey;
  label: string;
  emoji: string;
  group: GroupKey;
};

// Order groups appear in the top nav. Also where the per-group icon comes from.
// P8-3: CRM positioned between Accounting and Reports — operator workflow is
// "invoice posts → check pipeline → log activity" so it follows Accounting and
// precedes the cross-functional Reports group.
// Top nav is grouped into FIVE section dropdowns; each section nests the
// existing groups as labelled sub-sections inside its dropdown. Keeps the bar
// short while preserving the group taxonomy. Every GroupKey must appear in
// exactly one section (else its modules vanish from the nav).
export const NAV_SECTIONS: { section: string; emoji: string; groups: GroupKey[] }[] = [
  // P28-1-2 — Today first: the assistant-first landing surface.
  { section: "Today",       emoji: "🌅", groups: ["Today"] },
  { section: "Master Data", emoji: "📚", groups: ["Master Data", "EDI"] },
  { section: "Accounting",  emoji: "💼", groups: ["Accounting", "Reports", "Approvals"] },
  // #983 — Treasury: cash/FX/cards/SCF/discounts/tax + parallel-run recon.
  { section: "Treasury",    emoji: "💰", groups: ["Treasury"] },
  { section: "Vendors",     emoji: "🏭", groups: ["Vendors"] },
  // Procurement — dedicated top-level section so the PO → Receiving → QC →
  // Customs → Broker → 3-Way Match → Recon → Bookkeeper → EDI chain is visible.
  // 🚚 is distinct from 📦 (Inventory) and every other section emoji.
  { section: "Procurement", emoji: "🚚", groups: ["Procurement"] },
  { section: "Inventory",   emoji: "📦", groups: ["Inventory", "Shadow Mirror"] },
  // Operator item #1 — Manufacturing promoted to its own top-level section
  // (was nested under Inventory; its masters were also under Master Data).
  { section: "Manufacturing", emoji: "🛠️", groups: ["Manufacturing"] },
  // Chunk I item 8 — split the former combined "Sales & CRM" header into two
  // distinct top-level headers: "Sales" (order entry + sales channels) and
  // "Customers" (CRM pipeline + customer-service cases), reachable separately.
  // Pricing (Price Lists + Promotions) folded under Sales.
  { section: "Sales",       emoji: "🛒", groups: ["Sales", "Pricing", "Shopify", "Marketplaces"] },
  { section: "Customers",   emoji: "🤝", groups: ["Customers", "Customers – Accts Rec", "CRM", "Customer Service"] },
  // #983 — ESG & Compliance: sustainability / ESG / diversity / audits / automation.
  { section: "ESG",         emoji: "🌱", groups: ["ESG & Compliance"] },
  // #983 — Workflow folded into Admin alongside Notifications / HR / Audit.
  { section: "Admin",       emoji: "🔧", groups: ["Notifications", "HR", "Workflow", "Audit", "Admin"] },
];

export const GROUP_ICON: Record<GroupKey, string> = {
  "Today":            "🌅",
  "Master Data":      "📚",
  "EDI":              "🔌",
  "Accounting":       "💼",
  "Treasury":         "💰",
  "Vendors":          "🏭",
  "Procurement":      "🚚",
  "Sales":            "🧾",
  "Pricing":          "🏷️",
  "CRM":              "🤝",
  "Customers":        "🤝",
  "Customers – Accts Rec": "📥",
  "Reports":          "📊",
  "ESG & Compliance": "🌱",
  "Workflow":         "⚙️",
  "Inventory":        "📦",
  "Manufacturing":    "🛠️",
  "Customer Service": "🎧",
  "Shopify":          "🛍️",
  "Marketplaces":     "🛒",
  "Shadow Mirror":    "🔁",
  "Approvals":        "✅",
  "Notifications":    "🔔",
  "HR":               "👥",
  "Audit":            "🕒",
  "Admin":            "🔧",
};

export const MODULES: ModuleDef[] = [
  // P28-1-2 — assistant-first landing page: to-dos, processes, current state.
  { key: "today",             label: "Today",             emoji: "🌅", group: "Today" },
  { key: "style_master",      label: "Style Master",      emoji: "🎨", group: "Master Data" },
  // P8-8: PIM Product Catalog — metadata (attributes / descriptions / images)
  // on top of the styles created in Style Master.
  { key: "pim_catalog",       label: "Product Catalog Master",   emoji: "🏷️", group: "Master Data" },
  { key: "fabric_codes",      label: "Fabric Codes Master",      emoji: "🧵", group: "Master Data" },
  { key: "vendor_master",     label: "Vendor Master",     emoji: "🏭", group: "Master Data" },
  { key: "customer_master",   label: "Customer Master",   emoji: "🤝", group: "Master Data" },
  { key: "payment_terms",     label: "Payment Terms Master",     emoji: "📆", group: "Master Data" },
  // Chunk I — reference masters.
  { key: "countries",            label: "Countries Master",          emoji: "🌍", group: "Master Data" },
  { key: "genders",              label: "Genders Master",            emoji: "⚧", group: "Master Data" },
  { key: "style_classifications", label: "Group/Category/Sub Master", emoji: "🗂️", group: "Master Data" },
  { key: "factors",              label: "Factors/Insurance Master",  emoji: "🏦", group: "Master Data" },
  { key: "size_scales",          label: "Size Scales Master",        emoji: "📏", group: "Master Data" },
  { key: "season_master",        label: "Seasons Master",            emoji: "🍂", group: "Master Data" },
  { key: "color_master",         label: "Color Master",              emoji: "🎨", group: "Master Data" },
  { key: "fabric_mill_master",   label: "Fabric Mill Master",        emoji: "🏭", group: "Master Data" },
  { key: "part_master",          label: "Part Master",               emoji: "🧩", group: "Manufacturing" },
  { key: "service_item_master",  label: "Service Item Master",       emoji: "🛠️", group: "Manufacturing" },
  { key: "part_type_master",     label: "Part Type Master",          emoji: "🏷️", group: "Manufacturing" },
  { key: "rma_reason_master",    label: "RMA Reasons Master",        emoji: "↩️", group: "Master Data" },
  { key: "adjustment_type_master", label: "Adjustment Types Master", emoji: "⚙️", group: "Master Data" },
  { key: "adjustment_reason_master", label: "Adjustment Reason Master", emoji: "📋", group: "Master Data" },
  { key: "transfer_reason_master", label: "Transfer Reasons Master", emoji: "🔁", group: "Master Data" },
  { key: "date_preset_master",   label: "Date Presets Master",       emoji: "📅", group: "Master Data" },
  { key: "warehouse_master",     label: "Warehouses Master",         emoji: "🏬", group: "Master Data" },
  { key: "carrier_master",      label: "Carrier Master",            emoji: "🚚", group: "Master Data" },
  { key: "buyer_scope_master",  label: "Buyer Scope Master",        emoji: "🛒", group: "Master Data" },
  { key: "hts_master",           label: "HTS Master",                emoji: "🛃", group: "Master Data" },
  // P18-F — internal B2B admin panels (authorize buyers + manage price lists).
  { key: "b2b_accounts",   label: "B2B Buyers",     emoji: "🛍️", group: "Customers" },
  // M43 — Pricing Engine admin (price lists supersede the interim B2B price list).
  { key: "b2b_price_list",     label: "Price Lists", emoji: "🏷️", group: "Pricing" },
  { key: "pricing_promotions", label: "Promotions",  emoji: "🎁", group: "Pricing" },
  { key: "gl_accounts",       label: "Chart of Accounts", emoji: "📒", group: "Accounting" },
  { key: "gl_periods",        label: "Periods",           emoji: "🗓️", group: "Accounting" },
  { key: "journal_entries",   label: "Journal Entries",   emoji: "📓", group: "Accounting" },
  { key: "ap_invoices",       label: "AP Invoices",       emoji: "🧾", group: "Vendors" },
  { key: "ap_payments",       label: "AP Payments",       emoji: "💸", group: "Vendors" },
  { key: "ar_invoices",       label: "AR Invoices",       emoji: "🧮", group: "Customers – Accts Rec" },
  // P4-5: AR Receipts (customer payments + applications). Sibling to AR
  // Invoices above (P4-4).
  { key: "ar_receipts",       label: "AR Receipts",       emoji: "💵", group: "Customers – Accts Rec" },
  // P16/M10 — native Sales Order entry.
  { key: "sales_orders",      label: "Sales Orders",      emoji: "🛒", group: "Sales" },
  // P16/M18 — Allocations Workbench (cross-SO allocation).
  { key: "sales_allocations", label: "Allocations",       emoji: "📊", group: "Sales" },
  { key: "sales_returns",     label: "Returns/RMA",        emoji: "↩️", group: "Sales" },
  { key: "drop_ship",         label: "Drop-Ship",          emoji: "📦", group: "Sales" },
  { key: "three_pl",          label: "3PL",                emoji: "🚚", group: "Inventory" },
  { key: "three_pl_recon",    label: "3PL Inventory Recon", emoji: "📋", group: "Inventory" },
  // EDI restructured into a sub-menu under Master Data: Vendors / Customers /
  // Settings. The existing vendor X12 panel keeps key `edi`, relabelled "Vendors".
  { key: "edi",               label: "Vendors",            emoji: "🏭", group: "EDI" },
  { key: "edi_customers",     label: "Customers",          emoji: "🤝", group: "EDI" },
  { key: "edi_settings",      label: "Settings",           emoji: "⚙️", group: "EDI" },
  { key: "reports_hub",       label: "Reports & Analytics", emoji: "📊", group: "Reports" },
  { key: "fixed_assets",      label: "Fixed Assets",       emoji: "🏢", group: "Accounting" },
  { key: "budgets",           label: "Budgets",            emoji: "🎯", group: "Accounting" },
  { key: "form_1099",         label: "1099 Worksheet",     emoji: "🧾", group: "Accounting" },
  { key: "sales_tax",         label: "Sales Tax & VAT",    emoji: "🏛️", group: "Accounting" },
  // P4-6: AR Aging report (per-customer buckets) + daily overdue cron.
  { key: "ar_aging",          label: "AR Aging",          emoji: "📅", group: "Customers – Accts Rec" },
  // AR Collections — worklist, promise-to-pay pipeline, activity log over open AR.
  { key: "ar_collections",    label: "Collections",       emoji: "📞", group: "Customers – Accts Rec" },
  // P4-8: Historical backfill — one-shot operator tool.
  { key: "ar_backfill",       label: "AR Backfill",       emoji: "🗄️", group: "Customers – Accts Rec" },
  // P5-2: Trial Balance — foundation report for all the other financial statements.
  { key: "trial_balance",     label: "Trial Balance",     emoji: "📊", group: "Accounting" },
  // P5-3: Income Statement (P&L) — revenue + COGS + opex with subtotals.
  { key: "income_statement",  label: "Income Statement",  emoji: "📈", group: "Accounting" },
  // P26: Segment / Dimensional P&L — revenue + margin by brand × channel × warehouse × gender.
  { key: "segment_pl",        label: "Segment P&L",       emoji: "📈", group: "Accounting" },
  // P5-4: Balance Sheet (assets / liabilities / equity as-of).
  { key: "balance_sheet",     label: "Balance Sheet",     emoji: "📋", group: "Accounting" },
  // Multi-entity consolidation — Σ member entities − intercompany eliminations.
  { key: "consolidation",     label: "Consolidation",     emoji: "🏛️", group: "Accounting" },
  // P5-5: Cash Flow Statement (indirect method).
  { key: "cash_flow",         label: "Cash Flow",         emoji: "💧", group: "Accounting" },
  // P5-6: Year-End Close — one-shot operator tool, terminal flip on all 12 periods of the FY.
  { key: "year_end_close",    label: "Year-End Close",    emoji: "🔚", group: "Accounting" },
  // P6-5: Bank Reconciliation (accounts overview + unmatched txn queue).
  { key: "bank_reconciliation", label: "Bank Reconciliation", emoji: "🏦", group: "Accounting" },
  // P6-6: Per (bank_account, period) reconciliation report.
  { key: "bank_recon_report", label: "Recon Report",      emoji: "⚖️", group: "Accounting" },
  // Factor Module Phase 1 — Rosenthal monthly statements + open-AR detail + GL 1107 tie-out.
  { key: "factor_recon",      label: "Factor (Rosenthal)", emoji: "🏦", group: "Accounting" },
  // Chargeback Management — matched-invoice worklist, disposition workflow, dilution.
  { key: "chargebacks",       label: "Chargebacks",        emoji: "🧾", group: "Accounting" },
  // Month-End Close — per-period close checklist (auto tie-outs + manual sign-offs) + period locking.
  { key: "month_end_close",   label: "Month-End Close",    emoji: "🔒", group: "Accounting" },
  // Xoro Monthly Recon — divergence-aware month-by-month TB recon vs the Xoro GL mirror.
  { key: "xoro_recon",        label: "Xoro Monthly Recon", emoji: "🔬", group: "Accounting" },
  // P7-6: M44 Commission Accruals + Commission Payouts. (Sales Reps master
  // removed — reps are managed as Employees; commission panels read the
  // sales_reps table directly via /api/internal/sales-reps GET.)
  { key: "commission_accruals",   label: "Commission Accruals",   emoji: "💰", group: "Accounting" },
  { key: "commission_payouts",    label: "Commission Payouts",    emoji: "📜", group: "Accounting" },
  { key: "approval_rules",    label: "Approval Rules",    emoji: "⚙️", group: "Approvals" },
  { key: "approval_requests", label: "Approval Inbox",    emoji: "✅", group: "Approvals" },
  { key: "notifications",     label: "Notifications",     emoji: "🔔", group: "Notifications" },
  { key: "notification_prefs",label: "Notif. Preferences",emoji: "🎚️", group: "Notifications" },
  { key: "employees",         label: "Employees",         emoji: "👥", group: "HR" },
  // P16 — Employee Title + Department reference masters.
  { key: "employee_titles",      label: "Employee Titles",      emoji: "🏷️", group: "HR" },
  { key: "employee_departments", label: "Employee Departments", emoji: "🏢", group: "HR" },
  // P16/M11 — native Purchase Orders (origination + matrix line entry).
  { key: "purchase_orders",     label: "Purchase Orders",   emoji: "📦", group: "Procurement" },
  // P13/C1 — Receiving + bookkeeper approval (procurement operational layer).
  { key: "receiving",           label: "Receiving",         emoji: "📥", group: "Procurement" },
  { key: "bookkeeper_approval", label: "Bookkeeper Approval", emoji: "🧾", group: "Procurement" },
  // P13/C2-C4 — QC + trade compliance + 3-way match.
  { key: "qc_inspections",      label: "QC Inspections",    emoji: "🔍", group: "Procurement" },
  { key: "customs_entries",     label: "Customs Entries",   emoji: "🛃", group: "Procurement" },
  { key: "broker_invoices",     label: "Broker Invoices",   emoji: "🚢", group: "Procurement" },
  { key: "three_way_match",     label: "3-Way Match",       emoji: "⚖️", group: "Procurement" },
  { key: "procurement_recon",   label: "Procurement Recon", emoji: "🧮", group: "Procurement" },
  { key: "inventory_matrix",    label: "Inventory Matrix",  emoji: "🧮", group: "Inventory" },
  // Prepack Matrix Driver — per-size pack composition master (drives Explode-PPK).
  { key: "prepack_matrices",    label: "Prepack Matrices Master",  emoji: "📦", group: "Master Data" },
  { key: "inventory_transfers", label: "Inventory Transfers", emoji: "🔁", group: "Inventory" },
  { key: "inventory_adjustments", label: "Inventory Adjustments", emoji: "📐", group: "Inventory" },
  // Read-only on-hand accuracy monitor: layers-vs-Xoro-REST divergence.
  { key: "inventory_accuracy", label: "Inventory Accuracy", emoji: "🎯", group: "Inventory" },
  // Read-only aged-inventory report: FIFO-layer ages, carrying cost, velocity.
  { key: "inventory_aging",   label: "Inventory Aging",   emoji: "⏳", group: "Inventory" },
  { key: "cycle_counts",      label: "Cycle Counts",      emoji: "📋", group: "Inventory" },
  { key: "scanner_sessions",  label: "Scanner Sessions",  emoji: "📱", group: "Inventory" },
  // Manufacturing — parts inventory + (later) BOM + build orders.
  { key: "part_inventory",    label: "Part Inventory",    emoji: "🧩", group: "Manufacturing" },
  { key: "mfg_bom",           label: "Bill of Materials", emoji: "📋", group: "Manufacturing" },
  { key: "mfg_build_orders",  label: "Build Orders",      emoji: "🛠️", group: "Manufacturing" },
  { key: "mfg_reports",       label: "Mfg Reports",       emoji: "📊", group: "Manufacturing" },
  // P7-9: M47 Customer Service / Cases panel.
  { key: "cases",             label: "Cases",             emoji: "🎫", group: "Customer Service" },
  // P7-7: M9-subset operational reports (AP Aging + Sales by Rep + Sales by
  // Customer + GL Detail). AR items (incl. AR Aging) now live under the
  // "Customers – Accts Rec" group; the Reports menu group hosts these reports.
  { key: "ap_aging",          label: "AP Aging (report)", emoji: "📅", group: "Vendors" },
  // Nav reorg: Sales by Rep → Sales section; Sales by Customer → Customers section.
  { key: "sales_by_rep",      label: "Sales by Rep",      emoji: "🧑‍💼", group: "Sales" },
  { key: "sales_by_customer", label: "Sales by Customer", emoji: "🤝", group: "Customers" },
  { key: "gl_detail",         label: "GL Detail",         emoji: "🔍", group: "Reports" },
  { key: "upc_report",        label: "UPC Report",        emoji: "🔖", group: "Reports" },
  // P8-3 — M25 CRM panels under new 🤝 CRM nav group.
  { key: "crm_opportunities",   label: "Opportunities",     emoji: "💼", group: "CRM" },
  { key: "crm_activities",      label: "Activities",        emoji: "📋", group: "CRM" },
  { key: "crm_tasks",           label: "Tasks",             emoji: "✅", group: "CRM" },
  { key: "crm_pipeline_report", label: "Pipeline Report",   emoji: "📊", group: "CRM" },
  // Cross-cutter T10-7 — Shadow Mirror Status dashboard (single panel under 🔁).
  { key: "shadow_mirror",       label: "Mirror Status",     emoji: "🔁", group: "Shadow Mirror" },
  // P11-7 — Shopify Refunds reports panel (read-only audit surface).
  { key: "shopify_refunds",     label: "Refunds",           emoji: "↩️", group: "Shopify" },
  // P11 — Connect Shopify Store (encrypted token; enables sync + image pull).
  { key: "shopify_stores",      label: "Connect Store",     emoji: "🛍️", group: "Shopify" },
  // Tangerine P12-99 — Marketplaces close-out status panel (Shopify / FBA / Walmart / Faire).
  { key: "marketplace_status",  label: "Marketplace Status",emoji: "🛒", group: "Marketplaces" },
  // Cross-cutter T11-3 — Universal audit log admin panel (operator-facing row_changes browser).
  { key: "audit_log",           label: "Audit Log",         emoji: "🕒", group: "Audit" },
  // P14-3b — RBAC User Access (role matrix + per-cell overrides).
  { key: "user_access",         label: "User Access",       emoji: "🔐", group: "Admin" },
  // Nav-reachable scorecard entry points (also opened by the 📊 row buttons).
  { key: "vendor_scorecard",    label: "Vendor Scorecard",   emoji: "📊", group: "Vendors" },
  { key: "customer_scorecard",  label: "Customer Scorecard", emoji: "📊", group: "Customers" },
  // #983 — Treasury group: cash management + parallel-run reconciliation.
  { key: "payments",            label: "Payments",           emoji: "💸", group: "Treasury" },
  { key: "recon_dashboard",     label: "Reconciliation",     emoji: "⚖️", group: "Treasury" },
  { key: "fx",                  label: "FX",                 emoji: "🌐", group: "Treasury" },
  { key: "virtual_cards",       label: "Virtual Cards",      emoji: "💳", group: "Treasury" },
  { key: "scf",                 label: "Supply Chain Finance", emoji: "🏦", group: "Treasury" },
  { key: "discount_offers",     label: "Discount Offers",    emoji: "⚡", group: "Treasury" },
  { key: "tax",                 label: "Tax",                emoji: "🧾", group: "Treasury" },
  // #983 — Procurement: RFQ list (detail view InternalRfqDetail stays props-driven).
  { key: "rfqs",                label: "RFQs",               emoji: "📨", group: "Procurement" },
  // #983 — Reports analytics suite.
  { key: "analytics",           label: "Analytics",          emoji: "📊", group: "Reports" },
  { key: "insights",            label: "Insights",           emoji: "💡", group: "Reports" },
  { key: "anomalies",           label: "Anomalies",          emoji: "🚨", group: "Reports" },
  { key: "benchmark",           label: "Benchmark",          emoji: "📈", group: "Reports" },
  { key: "health_scores",       label: "Vendor Health",      emoji: "❤️", group: "Vendors" },
  { key: "preferred",           label: "Preferred Vendors",  emoji: "⭐", group: "Reports" },
  // #983 — ESG & Compliance group.
  { key: "sustainability",      label: "Sustainability",     emoji: "🌿", group: "ESG & Compliance" },
  { key: "esg_scores",          label: "ESG Scores",         emoji: "🌍", group: "ESG & Compliance" },
  { key: "diversity",           label: "Diversity",          emoji: "🤲", group: "ESG & Compliance" },
  { key: "compliance_audit",    label: "Compliance Audit",   emoji: "📜", group: "ESG & Compliance" },
  { key: "compliance_automation", label: "Compliance Automation", emoji: "🤖", group: "ESG & Compliance" },
  // #983 — Workflow group (folded under Admin section).
  { key: "workflow_rules",      label: "Workflow Rules",     emoji: "🧩", group: "Workflow" },
  { key: "workflow_executions", label: "Approvals Queue",    emoji: "🗳️", group: "Workflow" },
  { key: "workspaces",          label: "Workspaces",         emoji: "🗂️", group: "Workflow" },
  // #983 — Marketplaces (vendor sourcing marketplace + inquiries).
  { key: "marketplace",         label: "Marketplace",        emoji: "🛍️", group: "Marketplaces" },
  { key: "marketplace_inquiries", label: "Marketplace Inquiries", emoji: "📩", group: "Marketplaces" },
  // #983 — Admin: entity registry + vendor onboarding.
  { key: "entities",            label: "Entities",           emoji: "🏛️", group: "Admin" },
  { key: "onboarding",          label: "Onboarding",         emoji: "🚀", group: "Admin" },
  // M15 — External / Partner API key admin.
  { key: "api_keys",            label: "API Keys",           emoji: "🔑", group: "Admin" },
  { key: "sync_health",         label: "Sync Health",        emoji: "🩺", group: "Admin" },
  { key: "cutover_recon",       label: "Cutover Reconciliation", emoji: "🧮", group: "Admin" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Apps launcher — links to the other modules within the design-calendar-app
// suite. Each opens the app in its own browser tab (target="_blank").
// ─────────────────────────────────────────────────────────────────────────────
export type AppLink = { href: string; label: string; emoji: string; description: string };

export const APPS: AppLink[] = [
  { href: "/",          label: "Design Calendar", emoji: "📅", description: "Calendar, tasks, collections" },
  { href: "/tanda",     label: "PO WIP",          emoji: "📦", description: "Purchase orders, shipments, invoices" },
  { href: "/ats",       label: "ATS Planning",    emoji: "📊", description: "Available-to-ship inventory grid" },
  { href: "/techpack",  label: "Tech Packs",      emoji: "📐", description: "Style spec sheets" },
  { href: "/gs1",       label: "GS1 Labels",      emoji: "🏷️", description: "GTIN-14 prepack labels" },
  { href: "/planning",  label: "Planning",        emoji: "📈", description: "Inventory forecasting" },
  { href: "/costing",   label: "Costing",         emoji: "💰", description: "Costing projects, quotes, margins" },
  { href: "/vendor",    label: "Vendor Portal",   emoji: "🌐", description: "External vendor view (separate auth)" },
];

// M31 — the standalone Planning app's screens, surfaced as first-class deep
// links inside the Tangerine shell (header nav + home landing). The Planning
// app keeps its own shell once you land there; these are entry points. No data
// plumbing yet — Planning still reads its own Xoro/Shopify-backed tables.
export const PLANNING_SCREENS: AppLink[] = [
  { href: "/planning/wholesale", label: "Wholesale", emoji: "🛒", description: "Wholesale demand forecast" },
  { href: "/planning/ecom",      label: "Ecom",      emoji: "🛍️", description: "Shopify weekly forecast" },
  { href: "/planning/supply",    label: "Supply",    emoji: "⚖️", description: "Supply reconciliation + buy recs" },
  { href: "/planning/scenarios", label: "Scenarios", emoji: "🔀", description: "What-if planning + exports" },
  { href: "/planning/accuracy",  label: "Accuracy",  emoji: "🎯", description: "Forecast accuracy + AI" },
  { href: "/planning/execution", label: "Execution", emoji: "🚀", description: "Approved buy-plan batches" },
];
