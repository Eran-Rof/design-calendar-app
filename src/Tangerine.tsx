// src/Tangerine.tsx
//
// Tangerine ERP — independent shell. Hosts the 6 P1 admin panels and provides
// an Apps launcher linking to the other modules (Design Calendar, PO WIP, ATS,
// Tech Packs, GS1, Planning, Vendor Portal).
//
// Architectural note: previously these 6 admin panels lived inside the Tanda
// (PO WIP) app's "Vendors ▾" dropdown, which was the wrong long-term home —
// Tangerine should be the parent ERP shell that hosts everything else, not a
// sub-feature of one PLM app. Chunk T1 (2026-05-26) moves them out.
//
// Panel React components themselves still live at src/tanda/Internal*.tsx for
// now (they're reusable; importing across folders is fine). A future cleanup
// can rename them to src/tangerine/*Panel.tsx for clarity but it's cosmetic.

import { useEffect, useMemo, useRef, useState } from "react";
import { WarnHost, notify, confirmDialog } from "./shared/ui/warn";

import InternalStyleMaster        from "./tanda/InternalStyleMaster";
import InternalPimProductCatalog  from "./tanda/InternalPimProductCatalog";
import InternalFabricCodes        from "./tanda/InternalFabricCodes";
import InternalVendorMaster       from "./tanda/InternalVendorMaster";
import InternalCustomerMaster     from "./tanda/InternalCustomerMaster";
import InternalPaymentTerms       from "./tanda/InternalPaymentTerms";
import InternalSizeScales         from "./tanda/InternalSizeScales";
import InternalB2BAccounts        from "./tanda/InternalB2BAccounts";
import InternalPriceLists         from "./tanda/InternalPriceLists";
import InternalPromotions         from "./tanda/InternalPromotions";
import InternalCountries          from "./tanda/InternalCountries";
import InternalGenders            from "./tanda/InternalGenders";
import InternalStyleClassifications from "./tanda/InternalStyleClassifications";
import InternalFactors            from "./tanda/InternalFactors";
import InternalCOA                from "./tanda/InternalCOA";
import InternalPeriods            from "./tanda/InternalPeriods";
import InternalJournalEntry       from "./tanda/InternalJournalEntry";
import InternalAPInvoices         from "./tanda/InternalAPInvoices";
import InternalAPPayments         from "./tanda/InternalAPPayments";
import InternalARInvoices         from "./tanda/InternalARInvoices";
import InternalSalesOrders        from "./tanda/InternalSalesOrders";
import InternalAllocations        from "./tanda/InternalAllocations";
import InternalSalesReturns       from "./tanda/InternalSalesReturns";
import InternalDropShip          from "./tanda/InternalDropShip";
import InternalThreePL           from "./tanda/InternalThreePL";
import InternalEDI               from "./tanda/InternalEDI";
import InternalReportsHub        from "./tanda/InternalReportsHub";
import InternalFixedAssets       from "./tanda/InternalFixedAssets";
import InternalBudgets           from "./tanda/InternalBudgets";
import InternalForm1099          from "./tanda/InternalForm1099";
import InternalPurchaseOrders     from "./tanda/InternalPurchaseOrders";
import InternalReceiving          from "./tanda/InternalReceiving";
import InternalBookkeeperApproval from "./tanda/InternalBookkeeperApproval";
import InternalQCInspections      from "./tanda/InternalQCInspections";
import InternalCustomsEntries     from "./tanda/InternalCustomsEntries";
import InternalBrokerInvoices     from "./tanda/InternalBrokerInvoices";
import InternalThreeWayMatch      from "./tanda/InternalThreeWayMatch";
import InternalProcurementRecon   from "./tanda/InternalProcurementRecon";
import InternalARReceipts         from "./tanda/InternalARReceipts";
import InternalARAging            from "./tanda/InternalARAging";
// P7-7 — M9-subset operational reports under the new 📊 Reports group.
import InternalAPAging            from "./tanda/InternalAPAging";
import InternalSalesByRep         from "./tanda/InternalSalesByRep";
import InternalSalesByCustomer    from "./tanda/InternalSalesByCustomer";
import InternalGLDetail           from "./tanda/InternalGLDetail";
import InternalARBackfill         from "./tanda/InternalARBackfill";
import InternalTrialBalance       from "./tanda/InternalTrialBalance";
import InternalIncomeStatement    from "./tanda/InternalIncomeStatement";
import InternalBalanceSheet       from "./tanda/InternalBalanceSheet";
import InternalCashFlow           from "./tanda/InternalCashFlow";
import InternalYearEndClose       from "./tanda/InternalYearEndClose";
import InternalBankReconciliation from "./tanda/InternalBankReconciliation";
import InternalBankReconReport    from "./tanda/InternalBankReconReport";
import InternalApprovalRules           from "./tanda/InternalApprovalRules";
import InternalApprovalRequests        from "./tanda/InternalApprovalRequests";
import InternalNotificationCenter      from "./tanda/InternalNotificationCenter";
import InternalNotificationPreferences from "./tanda/InternalNotificationPreferences";
import InternalEmployees               from "./tanda/InternalEmployees";
import InternalEmployeeTitles          from "./tanda/InternalEmployeeTitles";
import InternalEmployeeDepartments     from "./tanda/InternalEmployeeDepartments";
import InternalInventoryMatrix          from "./tanda/InternalInventoryMatrix";
import InternalPrepackMatrix            from "./tanda/InternalPrepackMatrix";
import InternalInventoryTransfers      from "./tanda/InternalInventoryTransfers";
import InternalInventoryAdjustments    from "./tanda/InternalInventoryAdjustments";
import InternalCycleCounts             from "./tanda/InternalCycleCounts";
import InternalScannerSessions         from "./tanda/InternalScannerSessions";
import InternalCases                   from "./tanda/InternalCases";
// P8-3 — M25 CRM panels (Opportunities + Activities + Tasks + Pipeline Report).
import InternalCrmOpportunities       from "./tanda/InternalCrmOpportunities";
import InternalCrmActivities          from "./tanda/InternalCrmActivities";
import InternalCrmTasks               from "./tanda/InternalCrmTasks";
import InternalCrmPipelineReport      from "./tanda/InternalCrmPipelineReport";
// Cross-cutter T10-7 — Shadow Mirror Status panel (Xoro → Tangerine nightly mirror dashboard).
import InternalShadowMirrorStatus     from "./tanda/InternalShadowMirrorStatus";
// P11-7 — Shopify Refunds reports panel.
import InternalShopifyRefunds         from "./tanda/InternalShopifyRefunds";
// Tangerine P12-99 — Marketplaces status panel (Shopify / FBA / Walmart / Faire dashboard).
import InternalMarketplaceStatus      from "./tanda/InternalMarketplaceStatus";
// Cross-cutter T11-3 — Universal audit log admin panel (🕒 Audit nav group).
import InternalAuditLog                from "./tanda/InternalAuditLog";
// P14-3b — RBAC User Access admin panel (🔐 Admin nav group).
import InternalUserAccess              from "./tanda/InternalUserAccess";
// P14-4 — client menu hide driven by the caller's effective permissions.
import { useEffectivePermissions } from "./hooks/useEffectivePermissions";
import { rbacModuleForTangerine } from "./lib/rbacModuleMap";
// M31 — surface the standalone Planning app inside the Tangerine shell; gate by
// the shared PLM per-app permission (`permissions.planning.access`, default-true).
import { canAccessAppFromSession } from "./permissions";
// Cross-cutter T4-3 — Personalization favorites drawer.
import FavoritesMenu from "./components/FavoritesMenu";
// Tangerine P10-5 — Top-bar entity switcher (visible when caller has ≥2 entities).
import EntitySwitcher from "./components/EntitySwitcher";
import BrandChannelSwitcher from "./components/BrandChannelSwitcher";
// Cross-cutter T4-4 — Auto-landing redirect to operator's home_route.
import AutoLandingToast from "./components/AutoLandingToast";
import { useAutoLanding } from "./hooks/useAutoLanding";
import InternalCommissionAccruals      from "./tanda/InternalCommissionAccruals";
import InternalCommissionPayouts       from "./tanda/InternalCommissionPayouts";
// Nav-reachable scorecard entry points (wrap the existing drill-through modals).
import InternalVendorScorecard         from "./tanda/InternalVendorScorecard";
import InternalCustomerScorecard       from "./tanda/InternalCustomerScorecard";
import { clearMsTokens, getMsAccessToken, loadMsTokens, msSignIn } from "./utils/msAuth";
import { setCachedAuthUserId, setCachedAuthUserEmail, setCachedAuthUserName, setCachedAuthJwt } from "./utils/tangerineAuthUser";
import { GlobalSearchPaletteAuto } from "./components/GlobalSearchPalette";

// ─────────────────────────────────────────────────────────────────────────────
// Theme — match the dark Tanda palette so the admin panels (which use the
// same color constants) blend in.
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
  primaryDim: "#1d4ed8",
  // Tangerine brand accent
  tangerine: "#fb923c",
  tangerineDim: "#c2410c",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tangerine modules — the 6 admin panels shipped in P1 Chunks 7/7b/7c/8a/8b/8c
// ─────────────────────────────────────────────────────────────────────────────
type ModuleKey =
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
  | "edi"
  | "reports_hub"
  | "fixed_assets"
  | "budgets"
  | "form_1099"
  | "ar_aging"
  | "ar_backfill"
  | "trial_balance"
  | "income_statement"
  | "balance_sheet"
  | "cash_flow"
  | "year_end_close"
  | "bank_reconciliation"
  | "bank_recon_report"
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
  // Tangerine P12-99 — Marketplaces status (Shopify / FBA / Walmart / Faire).
  | "marketplace_status"
  // Cross-cutter T11-3 — Universal audit log admin panel (🕒 Audit).
  | "audit_log"
  | "vendor_scorecard"
  | "customer_scorecard"
  | "commission_accruals"
  | "commission_payouts"
  // P14-3b — RBAC User Access admin panel (🔐 Admin).
  | "user_access";

type GroupKey = "Master Data" | "Accounting" | "Vendors" | "Sales" | "CRM" | "Customers" | "Customers – Accts Rec" | "Reports" | "Approvals" | "Notifications" | "HR" | "Inventory" | "Customer Service" | "Shadow Mirror" | "Shopify" | "Marketplaces" | "Audit" | "Admin";

type ModuleDef = {
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
const NAV_SECTIONS: { section: string; emoji: string; groups: GroupKey[] }[] = [
  { section: "Master Data", emoji: "📚", groups: ["Master Data"] },
  { section: "Accounting",  emoji: "💼", groups: ["Accounting", "Reports", "Approvals"] },
  { section: "Vendors",     emoji: "🏭", groups: ["Vendors"] },
  { section: "Inventory",   emoji: "📦", groups: ["Inventory", "Shadow Mirror"] },
  // Chunk I item 8 — split the former combined "Sales & CRM" header into two
  // distinct top-level headers: "Sales" (order entry + sales channels) and
  // "Customers" (CRM pipeline + customer-service cases), reachable separately.
  { section: "Sales",       emoji: "🛒", groups: ["Sales", "Shopify", "Marketplaces"] },
  { section: "Customers",   emoji: "🤝", groups: ["Customers", "Customers – Accts Rec", "CRM", "Customer Service"] },
  { section: "Admin",       emoji: "🔧", groups: ["Notifications", "HR", "Audit", "Admin"] },
];

const GROUP_ICON: Record<GroupKey, string> = {
  "Master Data":      "📚",
  "Accounting":       "💼",
  "Vendors":          "🏭",
  "CRM":              "🤝",
  "Customers":        "🤝",
  "Customers – Accts Rec": "📥",
  "Reports":          "📊",
  "Inventory":        "📦",
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

const MODULES: ModuleDef[] = [
  { key: "style_master",      label: "Style Master",      emoji: "🎨", group: "Master Data" },
  // P8-8: PIM Product Catalog — metadata (attributes / descriptions / images)
  // on top of the styles created in Style Master.
  { key: "pim_catalog",       label: "Product Catalog",   emoji: "🏷️", group: "Master Data" },
  { key: "fabric_codes",      label: "Fabric Codes",      emoji: "🧵", group: "Master Data" },
  { key: "vendor_master",     label: "Vendor Master",     emoji: "🏭", group: "Master Data" },
  { key: "customer_master",   label: "Customer Master",   emoji: "🤝", group: "Master Data" },
  { key: "payment_terms",     label: "Payment Terms",     emoji: "📆", group: "Master Data" },
  // Chunk I — reference masters.
  { key: "countries",            label: "Countries",          emoji: "🌍", group: "Master Data" },
  { key: "genders",              label: "Genders",            emoji: "⚧", group: "Master Data" },
  { key: "style_classifications", label: "Group/Category/Sub", emoji: "🗂️", group: "Master Data" },
  { key: "factors",              label: "Factors/Insurance",  emoji: "🏦", group: "Master Data" },
  { key: "size_scales",          label: "Size Scales",        emoji: "📏", group: "Master Data" },
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
  { key: "edi",               label: "EDI",                emoji: "🔌", group: "Procurement" },
  { key: "reports_hub",       label: "Reports & Analytics", emoji: "📊", group: "Reports" },
  { key: "fixed_assets",      label: "Fixed Assets",       emoji: "🏢", group: "Accounting" },
  { key: "budgets",           label: "Budgets",            emoji: "🎯", group: "Accounting" },
  { key: "form_1099",         label: "1099 Worksheet",     emoji: "🧾", group: "Accounting" },
  // P4-6: AR Aging report (per-customer buckets) + daily overdue cron.
  { key: "ar_aging",          label: "AR Aging",          emoji: "📅", group: "Customers – Accts Rec" },
  // P4-8: Historical backfill — one-shot operator tool.
  { key: "ar_backfill",       label: "AR Backfill",       emoji: "🗄️", group: "Customers – Accts Rec" },
  // P5-2: Trial Balance — foundation report for all the other financial statements.
  { key: "trial_balance",     label: "Trial Balance",     emoji: "📊", group: "Accounting" },
  // P5-3: Income Statement (P&L) — revenue + COGS + opex with subtotals.
  { key: "income_statement",  label: "Income Statement",  emoji: "📈", group: "Accounting" },
  // P5-4: Balance Sheet (assets / liabilities / equity as-of).
  { key: "balance_sheet",     label: "Balance Sheet",     emoji: "📋", group: "Accounting" },
  // P5-5: Cash Flow Statement (indirect method).
  { key: "cash_flow",         label: "Cash Flow",         emoji: "💧", group: "Accounting" },
  // P5-6: Year-End Close — one-shot operator tool, terminal flip on all 12 periods of the FY.
  { key: "year_end_close",    label: "Year-End Close",    emoji: "🔚", group: "Accounting" },
  // P6-5: Bank Reconciliation (accounts overview + unmatched txn queue).
  { key: "bank_reconciliation", label: "Bank Reconciliation", emoji: "🏦", group: "Accounting" },
  // P6-6: Per (bank_account, period) reconciliation report.
  { key: "bank_recon_report", label: "Recon Report",      emoji: "⚖️", group: "Accounting" },
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
  { key: "prepack_matrices",    label: "Prepack Matrices",  emoji: "📦", group: "Master Data" },
  { key: "inventory_transfers", label: "Inventory Transfers", emoji: "🔁", group: "Inventory" },
  { key: "inventory_adjustments", label: "Inventory Adjustments", emoji: "📐", group: "Inventory" },
  { key: "cycle_counts",      label: "Cycle Counts",      emoji: "📋", group: "Inventory" },
  { key: "scanner_sessions",  label: "Scanner Sessions",  emoji: "📱", group: "Inventory" },
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
  // P8-3 — M25 CRM panels under new 🤝 CRM nav group.
  { key: "crm_opportunities",   label: "Opportunities",     emoji: "💼", group: "CRM" },
  { key: "crm_activities",      label: "Activities",        emoji: "📋", group: "CRM" },
  { key: "crm_tasks",           label: "Tasks",             emoji: "✅", group: "CRM" },
  { key: "crm_pipeline_report", label: "Pipeline Report",   emoji: "📊", group: "CRM" },
  // Cross-cutter T10-7 — Shadow Mirror Status dashboard (single panel under 🔁).
  { key: "shadow_mirror",       label: "Mirror Status",     emoji: "🔁", group: "Shadow Mirror" },
  // P11-7 — Shopify Refunds reports panel (read-only audit surface).
  { key: "shopify_refunds",     label: "Refunds",           emoji: "↩️", group: "Shopify" },
  // Tangerine P12-99 — Marketplaces close-out status panel (Shopify / FBA / Walmart / Faire).
  { key: "marketplace_status",  label: "Marketplace Status",emoji: "🛒", group: "Marketplaces" },
  // Cross-cutter T11-3 — Universal audit log admin panel (operator-facing row_changes browser).
  { key: "audit_log",           label: "Audit Log",         emoji: "🕒", group: "Audit" },
  // P14-3b — RBAC User Access (role matrix + per-cell overrides).
  { key: "user_access",         label: "User Access",       emoji: "🔐", group: "Admin" },
  // Nav-reachable scorecard entry points (also opened by the 📊 row buttons).
  { key: "vendor_scorecard",    label: "Vendor Scorecard",   emoji: "📊", group: "Vendors" },
  { key: "customer_scorecard",  label: "Customer Scorecard", emoji: "📊", group: "Customers" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Apps launcher — links to the other modules within the design-calendar-app
// suite. Each opens the app in its own browser tab (target="_blank").
// ─────────────────────────────────────────────────────────────────────────────
type AppLink = { href: string; label: string; emoji: string; description: string };

const APPS: AppLink[] = [
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
const PLANNING_SCREENS: AppLink[] = [
  { href: "/planning/wholesale", label: "Wholesale", emoji: "🛒", description: "Wholesale demand forecast" },
  { href: "/planning/ecom",      label: "Ecom",      emoji: "🛍️", description: "Shopify weekly forecast" },
  { href: "/planning/supply",    label: "Supply",    emoji: "⚖️", description: "Supply reconciliation + buy recs" },
  { href: "/planning/scenarios", label: "Scenarios", emoji: "🔀", description: "What-if planning + exports" },
  { href: "/planning/accuracy",  label: "Accuracy",  emoji: "🎯", description: "Forecast accuracy + AI" },
  { href: "/planning/execution", label: "Execution", emoji: "🚀", description: "Approved buy-plan batches" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
type AuthState = "loading" | "signed_out" | "signed_in";

export default function Tangerine() {
  // Cross-cutter T4-4 — auto-landing redirect to operator's home_route.
  // Fires once per tab session at app-shell root. See useAutoLanding.ts.
  const landing = useAutoLanding();
  // Deep-link / multi-tab support: `?m=<module_key>` drives activeModule so
  // opening ?m=journal_entries in a new tab lands directly on that panel.
  // Also accepts the legacy `?view=` param written by COA click-throughs etc.
  // Read on initial mount; subsequent navigation uses goToModule() below.
  const [activeModule, setActiveModule] = useState<ModuleKey | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const sp = new URLSearchParams(window.location.search);
      const v = sp.get("m") ?? sp.get("view");
      return v && (MODULES as { key: string }[]).some((m) => m.key === v)
        ? (v as ModuleKey)
        : null;
    } catch {
      return null;
    }
  });

  // ── URL sync helpers ──────────────────────────────────────────────────────
  // goToModule: single call-site that updates both React state and the browser
  // URL (?m=<key> or clear when null). Use pushState so back/forward work.
  function goToModule(key: ModuleKey | null) {
    setActiveModule(key);
    const url = new URL(window.location.href);
    if (key) {
      url.searchParams.set("m", key);
    } else {
      url.searchParams.delete("m");
    }
    // Also remove legacy ?view= if present, to keep the URL tidy.
    url.searchParams.delete("view");
    window.history.pushState({ module: key }, "", url.toString());
  }

  // popstate: handle browser back / forward buttons.
  useEffect(() => {
    function onPopState() {
      try {
        const sp = new URLSearchParams(window.location.search);
        const v = sp.get("m") ?? sp.get("view");
        const resolved =
          v && (MODULES as { key: string }[]).some((m) => m.key === v)
            ? (v as ModuleKey)
            : null;
        setActiveModule(resolved);
      } catch {
        setActiveModule(null);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser tab title = the active module's menu header, so every tab opened
  // via the menu (or a ?m= deep link) is identifiable at a glance. Falls back
  // to the app name on the home landing.
  useEffect(() => {
    const label = activeModule
      ? (MODULES as { key: string; label: string }[]).find((m) => m.key === activeModule)?.label
      : null;
    document.title = label ? `${label} · Tangerine` : "Tangerine ERP";
  }, [activeModule]);

  const [appsOpen, setAppsOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  // Chunk I item 1 — display name shown in the top bar (falls back to email).
  const [userName, setUserName] = useState<string | null>(null);

  // Auth gate: on mount, check for an MS token. If present + non-expired, fetch
  // the signed-in user's email from Graph (User.Read is already in MS_SCOPES).
  // No token → render the branded login screen.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tokens = loadMsTokens();
      if (!tokens) {
        if (!cancelled) setAuthState("signed_out");
        return;
      }
      try {
        const token = await getMsAccessToken();
        if (cancelled) return;
        if (!token) {
          setAuthState("signed_out");
          return;
        }
        const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`Graph /me HTTP ${r.status}`);
        const me = await r.json();
        if (cancelled) return;
        const resolvedEmail = me.mail || me.userPrincipalName || me.displayName || null;
        setUserEmail(resolvedEmail);
        // Chunk I item 1 — prefer the human display name in the header; fall
        // back to the email when Graph returns no displayName.
        const resolvedName = me.displayName || resolvedEmail;
        setUserName(resolvedName);
        // Cache the email snapshot so panels that need it for audit/notes
        // (e.g. Style Master notes log) can read it without re-querying Graph.
        setCachedAuthUserEmail(resolvedEmail);
        setCachedAuthUserName(resolvedName);
        setAuthState("signed_in");

        // Bridge MS OAuth → Supabase Auth. Best-effort: if the provision
        // endpoint fails (network / server-side mis-config), surface a
        // console warning but do NOT block the login — the operator can
        // still paste their uuid manually as a fallback while we debug.
        // First call creates auth.users + entity_users + links EB001;
        // subsequent calls are idempotent (ON CONFLICT DO NOTHING).
        try {
          const pr = await fetch("/api/internal/auth/provision", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ms_access_token: token }),
          });
          if (pr.ok) {
            const provisioned = await pr.json();
            if (!cancelled && provisioned?.auth_user_id) {
              setCachedAuthUserId(provisioned.auth_user_id);
              // P14 JWT phase — cache the per-user access token (present only
              // when SUPABASE_JWT_SECRET is set server-side). internalApiAuth
              // attaches it as Authorization: Bearer on every /api/internal
              // call, giving the server a verifiable per-user identity. When
              // absent (secret unset) we fall back to the cached-id stopgap.
              setCachedAuthJwt(provisioned.access_token ?? null);
            }
          } else {
            const detail = await pr.text().catch(() => "");
            console.warn("[Tangerine] auth provision returned non-OK:", pr.status, detail);
          }
        } catch (provErr) {
          console.warn("[Tangerine] auth provision failed (non-fatal):", provErr);
        }
      } catch (err) {
        console.error("[Tangerine] auth check failed:", err);
        if (!cancelled) setAuthState("signed_out");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSignIn() {
    try {
      await msSignIn();
      // Re-run the auth check by reloading; simpler than re-deriving state.
      window.location.reload();
    } catch (err) {
      console.error("[Tangerine] sign-in failed:", err);
      notify("Sign-in failed. See console for details.", "error");
    }
  }

  async function handleSignOut() {
    if (!(await confirmDialog("Sign out of Tangerine?", { title: "Sign out", icon: "🚪", confirmText: "Sign out" }))) return;
    clearMsTokens();
    // P14 JWT phase — drop the cached per-user token so a signed-out browser
    // can't keep presenting it. (It also expires server-side after 12h.)
    setCachedAuthJwt(null);
    window.location.reload();
  }

  if (authState === "loading") {
    return (
      <div style={{ background: C.bg, color: C.textMuted, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
        Checking authentication…
      </div>
    );
  }

  if (authState === "signed_out") {
    return <LoginScreen onSignIn={handleSignIn} />;
  }

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh" }}>
      <WarnHost />
      <TopNav
        activeModule={activeModule}
        onSelectModule={goToModule}
        appsOpen={appsOpen}
        onToggleApps={() => setAppsOpen((v) => !v)}
        onCloseApps={() => setAppsOpen(false)}
        onGoHome={() => goToModule(null)}
        userEmail={userEmail}
        userName={userName}
        onSignOut={handleSignOut}
      />

      <main style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
        {activeModule === null && <HomeLanding onSelectModule={goToModule} />}
        {activeModule === "style_master"    && <InternalStyleMaster />}
        {activeModule === "pim_catalog"     && <InternalPimProductCatalog />}
        {activeModule === "fabric_codes"    && <InternalFabricCodes />}
        {activeModule === "vendor_master"   && <InternalVendorMaster />}
        {activeModule === "customer_master" && <InternalCustomerMaster />}
        {activeModule === "payment_terms"   && <InternalPaymentTerms />}
        {activeModule === "countries"            && <InternalCountries />}
        {activeModule === "genders"              && <InternalGenders />}
        {activeModule === "style_classifications" && <InternalStyleClassifications />}
        {activeModule === "factors"              && <InternalFactors />}
        {activeModule === "size_scales"          && <InternalSizeScales />}
        {activeModule === "b2b_accounts"         && <InternalB2BAccounts />}
        {activeModule === "b2b_price_list"       && <InternalPriceLists />}
        {activeModule === "pricing_promotions"   && <InternalPromotions />}
        {activeModule === "gl_accounts"       && <InternalCOA />}
        {activeModule === "gl_periods"        && <InternalPeriods />}
        {activeModule === "journal_entries"   && <InternalJournalEntry />}
        {activeModule === "ap_invoices"       && <InternalAPInvoices />}
        {activeModule === "ap_payments"       && <InternalAPPayments />}
        {activeModule === "ar_invoices"       && <InternalARInvoices />}
        {activeModule === "ar_receipts"       && <InternalARReceipts />}
        {activeModule === "sales_orders"      && <InternalSalesOrders />}
        {activeModule === "sales_allocations" && <InternalAllocations />}
        {activeModule === "sales_returns" && <InternalSalesReturns />}
        {activeModule === "drop_ship" && <InternalDropShip />}
        {activeModule === "three_pl" && <InternalThreePL />}
        {activeModule === "edi" && <InternalEDI />}
        {activeModule === "reports_hub" && <InternalReportsHub />}
        {activeModule === "fixed_assets" && <InternalFixedAssets />}
        {activeModule === "budgets" && <InternalBudgets />}
        {activeModule === "form_1099" && <InternalForm1099 />}
        {activeModule === "purchase_orders"   && <InternalPurchaseOrders />}
        {activeModule === "receiving"         && <InternalReceiving />}
        {activeModule === "bookkeeper_approval" && <InternalBookkeeperApproval />}
        {activeModule === "qc_inspections"    && <InternalQCInspections />}
        {activeModule === "customs_entries"   && <InternalCustomsEntries />}
        {activeModule === "broker_invoices"   && <InternalBrokerInvoices />}
        {activeModule === "three_way_match"   && <InternalThreeWayMatch />}
        {activeModule === "procurement_recon" && <InternalProcurementRecon />}
        {activeModule === "ar_aging"          && <InternalARAging />}
        {activeModule === "ar_backfill"       && <InternalARBackfill />}
        {activeModule === "trial_balance"     && <InternalTrialBalance />}
        {activeModule === "income_statement"  && <InternalIncomeStatement />}
        {activeModule === "balance_sheet"     && <InternalBalanceSheet />}
        {activeModule === "cash_flow"         && <InternalCashFlow />}
        {activeModule === "year_end_close"    && <InternalYearEndClose />}
        {activeModule === "bank_reconciliation" && <InternalBankReconciliation />}
        {activeModule === "bank_recon_report" && <InternalBankReconReport />}
        {activeModule === "approval_rules"     && <InternalApprovalRules />}
        {activeModule === "approval_requests"  && <InternalApprovalRequests />}
        {activeModule === "notifications"      && <InternalNotificationCenter />}
        {activeModule === "notification_prefs" && <InternalNotificationPreferences />}
        {activeModule === "employees"          && <InternalEmployees />}
        {activeModule === "employee_titles"      && <InternalEmployeeTitles />}
        {activeModule === "employee_departments" && <InternalEmployeeDepartments />}
        {activeModule === "inventory_matrix"     && <InternalInventoryMatrix />}
        {activeModule === "prepack_matrices"     && <InternalPrepackMatrix />}
        {activeModule === "inventory_transfers" && <InternalInventoryTransfers />}
        {activeModule === "inventory_adjustments" && <InternalInventoryAdjustments />}
        {activeModule === "cycle_counts"        && <InternalCycleCounts />}
        {activeModule === "scanner_sessions"    && <InternalScannerSessions />}
        {activeModule === "cases"               && <InternalCases />}
        {/* P7-7 — Reports menu group */}
        {activeModule === "ap_aging"            && <InternalAPAging />}
        {activeModule === "sales_by_rep"        && <InternalSalesByRep />}
        {activeModule === "sales_by_customer"   && <InternalSalesByCustomer />}
        {activeModule === "gl_detail"           && <InternalGLDetail />}
        {/* P8-3 — M25 CRM panels */}
        {activeModule === "crm_opportunities"   && <InternalCrmOpportunities />}
        {activeModule === "crm_activities"      && <InternalCrmActivities />}
        {activeModule === "crm_tasks"           && <InternalCrmTasks />}
        {activeModule === "crm_pipeline_report" && <InternalCrmPipelineReport />}
        {/* Cross-cutter T10-7 — Shadow Mirror Status dashboard */}
        {activeModule === "shadow_mirror"       && <InternalShadowMirrorStatus />}
        {/* P11-7 — Shopify Refunds reports panel */}
        {activeModule === "shopify_refunds"     && <InternalShopifyRefunds />}
        {/* Tangerine P12-99 — Marketplaces close-out status dashboard */}
        {activeModule === "marketplace_status"  && <InternalMarketplaceStatus />}
        {/* Cross-cutter T11-3 — Universal audit log admin panel */}
        {activeModule === "audit_log"           && <InternalAuditLog />}
        {activeModule === "commission_accruals"   && <InternalCommissionAccruals />}
        {activeModule === "commission_payouts"    && <InternalCommissionPayouts />}
        {activeModule === "vendor_scorecard"      && <InternalVendorScorecard />}
        {activeModule === "customer_scorecard"    && <InternalCustomerScorecard />}
        {/* P14-3b — RBAC User Access admin panel */}
        {activeModule === "user_access"            && <InternalUserAccess />}
      </main>
      {/* Tangerine P10-5 — Top-bar entity switcher (fixed top-right). */}
      <EntitySwitcher />
      {/* P15 Brand Master C2 — global brand/channel pickers (fixed top-right).
          Inert until BRAND_SCOPE_MODE turns on per-report filtering (chunk 3). */}
      <BrandChannelSwitcher />
      {/* Cross-cutter T6-3 — ⌘K / Ctrl-K global search palette. Reachable
          from any module; invisible until the hotkey fires. */}
      <GlobalSearchPaletteAuto />
      {/* Cross-cutter T4-4 — auto-landing redirect toast (bottom-right). */}
      <AutoLandingToast landing={landing} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Branded login screen — shown when no MS token is present. Tangerine logo +
// "Sign in with Microsoft" button + a brief framing. Mirrors the rest of the
// design-calendar-app suite: same MS OAuth flow, different branded entry.
// ─────────────────────────────────────────────────────────────────────────────
function LoginScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div
      style={{
        background: `radial-gradient(ellipse at top left, ${C.tangerineDim}33 0%, ${C.bg} 50%)`,
        color: C.text,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          background: C.card,
          border: `1px solid ${C.cardBdr}`,
          borderRadius: 16,
          padding: 32,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: `linear-gradient(135deg, ${C.tangerine}, ${C.tangerineDim})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              fontWeight: 800,
              color: "white",
              boxShadow: `0 8px 24px ${C.tangerineDim}66`,
            }}
          >
            T
          </div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: C.text }}>Tangerine</span>
            <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 2 }}>ERP</span>
          </div>
        </div>

        <h1 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600 }}>Sign in to continue</h1>
        <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>
          Tangerine is the ERP shell for the design-calendar-app PLM suite. Sign in with your work Microsoft account to access master data + accounting.
        </p>

        <button
          type="button"
          onClick={onSignIn}
          style={{
            width: "100%",
            background: "white",
            color: "#1f1f1f",
            border: 0,
            padding: "12px 16px",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          Sign in with Microsoft
        </button>

        <p style={{ margin: "20px 0 0", fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>
          Uses the same Microsoft 365 account that signs you into the other PLM-suite apps (Design Calendar, PO WIP, ATS, Tech Packs, GS1, Planning). The popup may be blocked by some browsers — allow pop-ups for this domain if it doesn't open.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu-item finder — type-ahead jump to any panel, sits in the nav bar next to
// the section dropdowns. Filters the permission-checked panel list by label;
// Enter selects the top hit, ↑/↓ navigate, Esc clears.
// ─────────────────────────────────────────────────────────────────────────────
interface SearchItem { key: ModuleKey; label: string; emoji: string; section: string; }

function MenuSearch({ items, onSelect }: { items: SearchItem[]; onSelect: (k: ModuleKey) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return items
      .filter((it) => it.label.toLowerCase().includes(term) || it.section.toLowerCase().includes(term))
      .slice(0, 12);
  }, [q, items]);

  function choose(k: ModuleKey) { onSelect(k); setQ(""); setOpen(false); setHi(0); }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setQ(""); setOpen(false); return; }
    if (!results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[hi] || results[0]; if (r) choose(r.key); }
  }

  return (
    <div ref={ref} style={{ position: "relative", marginLeft: 12 }}>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => { if (q.trim()) setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder="🔍 Find a panel…"
        aria-label="Find a panel"
        style={{
          background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
          borderRadius: 6, padding: "6px 10px", fontSize: 13, width: 200, outline: "none",
        }}
      />
      {open && results.length > 0 && (
        <div
          role="listbox"
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0, minWidth: 280,
            background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: 6, zIndex: 70,
            display: "flex", flexDirection: "column", gap: 2, maxHeight: 360, overflowY: "auto",
          }}
        >
          {results.map((r, i) => (
            <button
              key={r.key}
              type="button"
              role="option"
              aria-selected={i === hi}
              onMouseEnter={() => setHi(i)}
              onClick={() => choose(r.key)}
              style={{
                background: i === hi ? "rgba(59, 130, 246, 0.14)" : "transparent",
                border: 0, color: i === hi ? C.text : C.textSub, padding: "8px 10px",
                borderRadius: 4, fontSize: 13, cursor: "pointer", textAlign: "left",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{ width: 18, display: "inline-block" }}>{r.emoji}</span>
              <span style={{ flex: 1 }}>{r.label}</span>
              <span style={{ fontSize: 10, color: C.textMuted }}>{r.section}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Top nav
// ─────────────────────────────────────────────────────────────────────────────
interface TopNavProps {
  activeModule: ModuleKey | null;
  onSelectModule: (m: ModuleKey) => void;
  appsOpen: boolean;
  onToggleApps: () => void;
  onCloseApps: () => void;
  onGoHome: () => void;
  userEmail: string | null;
  userName: string | null;
  onSignOut: () => void;
}

// Item 12 — is a modal/popup currently open in this tab? The Internal* panels
// render a full-screen fixed backdrop (position:fixed; inset:0; translucent
// dark background; high z-index). When one is open we open the next module in a
// NEW tab so the in-progress modal isn't lost; otherwise we navigate normally
// in the same tab. Clicks are rare, so a one-off DOM scan is fine.
function isModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  const nodes = document.querySelectorAll("div");
  for (let i = 0; i < nodes.length; i++) {
    const s = window.getComputedStyle(nodes[i]);
    if (
      s.position === "fixed" &&
      s.top === "0px" && s.left === "0px" && s.right === "0px" && s.bottom === "0px" &&
      parseInt(s.zIndex || "0", 10) >= 50
    ) {
      const bg = s.backgroundColor || "";
      const transparent = bg === "" || bg === "transparent" || /,\s*0\)\s*$/.test(bg);
      if (!transparent) return true; // a translucent full-screen backdrop = an open modal
    }
  }
  return false;
}

function TopNav({ activeModule, onSelectModule, appsOpen, onToggleApps, onCloseApps, onGoHome, userEmail, userName, onSignOut }: TopNavProps) {
  // Group-dropdown nav: hover the group → opens its menu; mouse leaves the
  // group container (button + dropdown) → closes immediately. openGroup is
  // also driven by click (keyboard / accessibility fallback) and Esc.
  const [openGroup, setOpenGroup] = useState<string | null>(null); // open SECTION name
  // Which sub-group's items show in the open section's flyout pane.
  const [hoverSub, setHoverSub] = useState<GroupKey | null>(null);
  // hoveredKey: per-dropdown highlighted item, drives the row background.
  const [hoveredKey, setHoveredKey] = useState<ModuleKey | null>(null);
  // P14-4 — hide nav items the caller lacks :read on. Inert (shows all) unless
  // RBAC_MODE=enforce on the server; see useEffectivePermissions.
  const { can } = useEffectivePermissions();

  // Hover-menu close debouncing. The absolute-positioned dropdown sits 4px
  // below the button — when the mouse traverses that gap on its way into
  // the menu, it briefly leaves the parent div's bounding box (absolutely
  // positioned children don't extend the parent's layout box). Without a
  // delay, that fires onMouseLeave and closes the menu before the cursor
  // reaches an item. A 140ms scheduled close lets the cursor land on the
  // dropdown (which cancels the timer via its own onMouseEnter) before the
  // close fires.
  const closeTimerRef = useRef<number | null>(null);
  function cancelClose() {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }
  function scheduleClose() {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpenGroup(null);
      setHoveredKey(null);
      closeTimerRef.current = null;
    }, 140);
  }
  useEffect(() => () => cancelClose(), []);

  // Close on Esc.
  useEffect(() => {
    if (openGroup == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { cancelClose(); setOpenGroup(null); setHoveredKey(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openGroup]);

  // Auto-close after selection.
  function handleSelect(m: ModuleKey) {
    cancelClose();
    setOpenGroup(null);
    setHoveredKey(null);
    onSelectModule(m);
  }

  // Flat, permission-filtered list of every panel for the menu-item finder,
  // each tagged with its section label for context in the results.
  const searchItems = useMemo<SearchItem[]>(() => {
    const sectionOf = (g: GroupKey): string =>
      NAV_SECTIONS.find((s) => s.groups.includes(g))?.section ?? "";
    return MODULES
      .filter((m) => can(rbacModuleForTangerine(m.key), "read"))
      .map((m) => ({ key: m.key, label: m.label, emoji: m.emoji, section: sectionOf(m.group) }));
  }, [can]);

  return (
    <header
      style={{
        background: "#0b1220",
        borderBottom: `1px solid ${C.cardBdr}`,
        padding: "10px 24px",
        display: "flex",
        alignItems: "center",
        gap: 20,
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <button
        type="button"
        onClick={onGoHome}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "transparent",
          border: 0,
          cursor: "pointer",
          padding: 0,
          color: C.text,
        }}
        title="Back to Tangerine home"
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: `linear-gradient(135deg, ${C.tangerine}, ${C.tangerineDim})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            fontWeight: 800,
            color: "white",
          }}
        >
          T
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.1 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Tangerine</span>
          <span style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>ERP</span>
        </div>
      </button>

      {/* Favorites — first action icon (consistent across all apps). */}
      <FavoritesMenu />

      <nav style={{ display: "flex", gap: 4, flex: 1, marginLeft: 20, alignItems: "center" }}>
        {NAV_SECTIONS.map((sec) => {
          // Sub-groups of this section that have at least one permitted module.
          const subGroups = sec.groups
            .map((g) => ({
              group: g,
              modules: MODULES.filter((m) => m.group === g && can(rbacModuleForTangerine(m.key), "read")),
            }))
            .filter((sg) => sg.modules.length > 0);
          if (subGroups.length === 0) return null;

          const containsActive = subGroups.some((sg) => sg.modules.some((m) => m.key === activeModule));
          const isOpen = openGroup === sec.section;
          const multi = subGroups.length > 1;
          // Sub-group whose items fill the flyout pane: hovered (if in this
          // section) → the one holding the active module → first.
          const shown =
            subGroups.find((sg) => sg.group === hoverSub) ||
            subGroups.find((sg) => sg.modules.some((m) => m.key === activeModule)) ||
            subGroups[0];

          return (
            <div
              key={sec.section}
              style={{ position: "relative" }}
              onMouseEnter={() => { cancelClose(); setOpenGroup(sec.section); setHoverSub(shown.group); }}
              onMouseLeave={() => scheduleClose()}
            >
              <button
                type="button"
                onClick={() => { setOpenGroup(isOpen ? null : sec.section); setHoverSub(shown.group); }}
                style={{
                  background: containsActive || isOpen ? C.card : "transparent",
                  border: `1px solid ${containsActive || isOpen ? C.cardBdr : "transparent"}`,
                  color: containsActive || isOpen ? C.text : C.textSub,
                  padding: "6px 12px", borderRadius: 6, fontSize: 13, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
                aria-haspopup="menu"
                aria-expanded={isOpen}
              >
                <span>{sec.emoji}</span>
                <span>{sec.section}</span>
                <span style={{ fontSize: 10 }}>{isOpen ? "▴" : "▾"}</span>
              </button>
              {isOpen && (
                <div
                  role="menu"
                  onMouseEnter={() => cancelClose()}
                  onMouseLeave={() => scheduleClose()}
                  style={{
                    position: "absolute", top: "100%", left: 0,
                    background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: 6, zIndex: 60,
                    display: "flex", gap: 4,
                  }}
                >
                  {/* Left rail: sub-group picker (only when >1 sub-group). */}
                  {multi && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 168, borderRight: `1px solid ${C.cardBdr}`, paddingRight: 6 }}>
                      {subGroups.map((sg) => {
                        const isShown = sg.group === shown.group;
                        const hasActive = sg.modules.some((m) => m.key === activeModule);
                        return (
                          <button
                            key={sg.group}
                            type="button"
                            onMouseEnter={() => setHoverSub(sg.group)}
                            onFocus={() => setHoverSub(sg.group)}
                            style={{
                              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                              background: isShown ? "#0b1220" : "transparent", border: 0,
                              color: hasActive ? "#60A5FA" : isShown ? C.text : C.textSub,
                              padding: "8px 10px", borderRadius: 4, fontSize: 13, cursor: "pointer",
                              textAlign: "left", fontWeight: hasActive ? 700 : 500,
                            }}
                          >
                            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ width: 18, display: "inline-block" }}>{GROUP_ICON[sg.group]}</span>
                              {sg.group}
                            </span>
                            <span style={{ fontSize: 10, opacity: 0.6 }}>▸</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {/* Right pane: the shown sub-group's modules.
                      Item 12 (tightened) — plain left-click navigates IN THIS TAB
                      normally. BUT if a modal/popup is currently open, we open the
                      module in a NEW tab instead, so the in-progress modal is never
                      lost. cmd/ctrl/shift/middle-click always open a new tab
                      natively (href is present; we don't preventDefault those). */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 224 }}>
                    {shown.modules.map((m) => {
                      const active = activeModule === m.key;
                      const hovered = hoveredKey === m.key;
                      return (
                        <a
                          key={m.key}
                          href={`?m=${m.key}`}
                          rel="noopener"
                          role="menuitem"
                          onClick={(e) => {
                            // Modifier / non-primary clicks → let the browser open a
                            // new tab natively (href handles it).
                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
                              cancelClose(); setOpenGroup(null); setHoveredKey(null);
                              return;
                            }
                            e.preventDefault();
                            cancelClose();
                            setOpenGroup(null);
                            setHoveredKey(null);
                            if (isModalOpen()) {
                              // Preserve the open modal in this tab — open elsewhere.
                              window.open(`?m=${m.key}`, "_blank", "noopener");
                            } else {
                              onSelectModule(m.key); // normal same-tab navigation
                            }
                          }}
                          onMouseEnter={() => setHoveredKey(m.key)}
                          onMouseLeave={() => setHoveredKey((cur) => (cur === m.key ? null : cur))}
                          style={{
                            background: hovered ? "rgba(59, 130, 246, 0.14)" : active ? "#0b1220" : "transparent",
                            border: 0, color: hovered || active ? C.text : C.textSub,
                            padding: "8px 10px", borderRadius: 4, fontSize: 13, cursor: "pointer",
                            textAlign: "left", display: "flex", alignItems: "center", gap: 8,
                            transition: "background 80ms ease, color 80ms ease",
                            textDecoration: "none",
                          }}
                        >
                          <span style={{ width: 18, display: "inline-block" }}>{m.emoji}</span>
                          <span>{m.label}</span>
                        </a>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* M31 — Planning is a separate app (own shell + nav); surface it as a
            first-class header link. Opens in a new tab so the Tangerine session
            is preserved. Gated by the shared planning permission. */}
        {canAccessAppFromSession("planning") && (
          <a
            href="/planning/wholesale"
            target="_blank"
            rel="noopener"
            title="Inventory planning — forecasting, supply, scenarios (opens in a new tab)"
            style={{
              background: "transparent", border: "1px solid transparent", color: C.textSub,
              padding: "6px 12px", borderRadius: 6, fontSize: 13, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6, textDecoration: "none",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.card; e.currentTarget.style.color = C.text; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textSub; }}
          >
            <span>📈</span><span>Planning</span><span style={{ fontSize: 10, opacity: 0.6 }}>↗</span>
          </a>
        )}

        {/* Menu-item finder — type-ahead jump to any panel, separate from the
            section dropdowns. Respects the same permission filter. */}
        <MenuSearch items={searchItems} onSelect={handleSelect} />
      </nav>

      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={onToggleApps}
          style={{
            background: appsOpen ? C.card : "transparent",
            border: `1px solid ${appsOpen ? C.cardBdr : C.cardBdr}`,
            color: C.text,
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: 13,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
          aria-haspopup="menu"
          aria-expanded={appsOpen}
        >
          <span>🧩</span>
          <span>Apps</span>
          <span style={{ fontSize: 10 }}>{appsOpen ? "▴" : "▾"}</span>
        </button>
        {appsOpen && <AppsLauncher onClose={onCloseApps} />}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 12, borderLeft: `1px solid ${C.cardBdr}`, marginLeft: 4 }}>
        {(userName || userEmail) && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2, fontSize: 11 }}>
            <span style={{ color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>Signed in</span>
            <span style={{ color: C.text, fontWeight: 600, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={userEmail || userName || ""}>
              {userName || userEmail}
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={onSignOut}
          style={{
            background: "transparent",
            border: `1px solid ${C.cardBdr}`,
            color: C.textSub,
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
          }}
          title="Sign out"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Apps launcher dropdown
// ─────────────────────────────────────────────────────────────────────────────
function AppsLauncher({ onClose }: { onClose: () => void }) {
  return (
    <>
      {/* Backdrop to close on outside click */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "transparent", zIndex: 50 }}
        aria-hidden
      />
      <div
        role="menu"
        style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          right: 0,
          width: 380,
          background: C.card,
          border: `1px solid ${C.cardBdr}`,
          borderRadius: 10,
          padding: 12,
          zIndex: 100,
          boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, padding: "0 4px" }}>
          Apps in the suite
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {APPS.map((a) => (
            <a
              key={a.href}
              href={a.href}
              target="_blank"
              rel="noopener"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                textDecoration: "none",
                color: C.text,
                background: "transparent",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.cardBdr; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              title={a.description}
            >
              <span style={{ fontSize: 22 }}>{a.emoji}</span>
              <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{a.label}</span>
                <span style={{ fontSize: 11, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.description}</span>
              </div>
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Home landing — shown when no module is active. Module cards + apps shortcut.
// ─────────────────────────────────────────────────────────────────────────────
function HomeLanding({ onSelectModule }: { onSelectModule: (m: ModuleKey) => void }) {
  // P14-4 — hide cards the caller lacks :read on. Inert unless RBAC_MODE=enforce.
  const { can } = useEffectivePermissions();
  const visibleModules = MODULES.filter((m) => can(rbacModuleForTangerine(m.key), "read"));
  const masterModules = visibleModules.filter((m) => m.group === "Master Data");
  const acctModules = visibleModules.filter((m) => m.group === "Accounting");
  const crmModules = visibleModules.filter((m) => m.group === "CRM");
  const reportsModules = visibleModules.filter((m) => m.group === "Reports");
  const approvalsModules = visibleModules.filter((m) => m.group === "Approvals");
  const notifModules = visibleModules.filter((m) => m.group === "Notifications");
  const hrModules = visibleModules.filter((m) => m.group === "HR");
  const inventoryModules = visibleModules.filter((m) => m.group === "Inventory");
  const vendorModules = visibleModules.filter((m) => m.group === "Vendors");
  const csModules = visibleModules.filter((m) => m.group === "Customer Service");
  const marketplacesModules = visibleModules.filter((m) => m.group === "Marketplaces");
  const mirrorModules = visibleModules.filter((m) => m.group === "Shadow Mirror");

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>Tangerine ERP</h1>
        <p style={{ margin: "4px 0 0", color: C.textMuted, fontSize: 14 }}>
          The operating system for your PLM suite. Master data + accounting + integration to the apps you already use.
        </p>
      </div>

      <Section title="Master Data">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {masterModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Accounting">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {acctModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Vendors">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {vendorModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
          {/* External vendor-facing portal (separate Supabase auth) — open in a new tab. */}
          <ExternalLinkCard href="/vendor" label="Vendor Portal" emoji="🌐" sublabel="External · new tab" />
          <ExternalLinkCard href="/vendor/onboarding" label="Vendor Onboarding" emoji="📝" sublabel="External · new tab" />
        </div>
      </Section>

      <Section title="CRM (P8)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {crmModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Reports (P7-7)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {reportsModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Approvals (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {approvalsModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Notifications (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {notifModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="HR (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {hrModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Inventory (P3)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {inventoryModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      {/* M31 — the standalone Planning app's screens as first-class deep links.
          Separate app (own shell, own Xoro/Shopify-backed data); opens in a new
          tab. Gated by the shared planning permission. */}
      {canAccessAppFromSession("planning") && (
        <Section title="Planning (M31)">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {PLANNING_SCREENS.map((s) => (
              <ExternalLinkCard key={s.href} href={s.href} label={s.label} emoji={s.emoji} sublabel={s.description} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Customer Service (P7)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {csModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Marketplaces (P11–P12)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {marketplacesModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Shadow Mirror (T10)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {mirrorModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Other apps in the suite">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {APPS.map((a) => (
            <a
              key={a.href}
              href={a.href}
              target="_blank"
              rel="noopener"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 14px",
                background: C.card,
                border: `1px solid ${C.cardBdr}`,
                borderRadius: 10,
                textDecoration: "none",
                color: C.text,
              }}
              title={a.description}
            >
              <span style={{ fontSize: 26 }}>{a.emoji}</span>
              <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{a.label}</span>
                <span style={{ fontSize: 11, color: C.textMuted }}>{a.description}</span>
              </div>
            </a>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ModuleCard({ module, onClick }: { module: ModuleDef; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: C.card,
        border: `1px solid ${C.cardBdr}`,
        borderRadius: 10,
        padding: 16,
        textAlign: "left",
        color: C.text,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        transition: "border-color 0.15s, transform 0.05s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.tangerine; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.cardBdr; }}
    >
      <div style={{ fontSize: 32 }}>{module.emoji}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{module.label}</div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{module.group}</div>
    </button>
  );
}

// External-link variant of ModuleCard: navigates to another app/route in a
// NEW TAB (mirrors the ATS link added to the Inventory Matrix). Used for the
// Vendor Portal + Vendor Onboarding entries, which live in the isolated
// /vendor app (separate Supabase auth) and so must open standalone.
function ExternalLinkCard({ href, label, emoji, sublabel }: { href: string; label: string; emoji: string; sublabel: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} — opens in a new tab`}
      style={{
        background: C.card,
        border: `1px solid ${C.cardBdr}`,
        borderRadius: 10,
        padding: 16,
        textAlign: "left",
        color: C.text,
        cursor: "pointer",
        textDecoration: "none",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        transition: "border-color 0.15s, transform 0.05s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.tangerine; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.cardBdr; }}
    >
      <div style={{ fontSize: 32 }}>{emoji}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{label} <span style={{ fontSize: 12, color: C.textMuted }}>↗</span></div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{sublabel}</div>
    </a>
  );
}
