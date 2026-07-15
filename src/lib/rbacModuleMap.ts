// src/lib/rbacModuleMap.ts
//
// P14-4 — maps client nav keys → P14-1 RBAC module_keys, so menu hiding can ask
// useEffectivePermissions().can(rbacModuleForX(navKey)). Mirrors the SERVER
// registry (api/_lib/rbac/routePermissions.js) on the read axis.
//
// Philosophy: map only what maps CONFIDENTLY. Anything not in these tables
// returns null → the menu item is ALWAYS shown (fail-open). We never hide a
// nav item we can't precisely attribute to a module the user might legitimately
// hold. Reports/master-data without a dedicated module_key (payment_terms,
// employees, CRM, commissions, sales_reps, cases) stay visible — RBAC for
// those arrives when their module_keys do.

// ── Tangerine ERP shell (src/Tangerine.tsx ModuleKey) → module_key ──────────
export const TANGERINE_MODULE_RBAC: Record<string, string> = {
  // Master data
  style_master: "style_master",
  fabric_codes: "style_master",
  pim_catalog: "product_master",
  vendor_master: "vendor_master",
  customer_master: "customer_master",
  // Scorecards reuse the underlying master module for RBAC gating.
  vendor_scorecard: "vendor_master",
  customer_scorecard: "customer_master",
  // Accounting — core
  gl_accounts: "coa",
  gl_periods: "gl_periods",
  year_end_close: "gl_periods",
  // Month-End Close rides the gl_periods module — close/reopen ARE period
  // status management (matches the server's "month-end-close" segment map).
  month_end_close: "gl_periods",
  // Xoro Monthly Recon — read-only TB reconciliation report → analytics module.
  xoro_recon: "analytics",
  journal_entries: "je_entry",
  ap_invoices: "ap_invoices",
  ap_payments: "ap_payments",
  ar_invoices: "ar_invoices",
  ar_receipts: "ar_receipts",
  ar_aging: "ar_invoices",
  ar_collections: "ar_invoices",
  ar_backfill: "ar_invoices",
  ap_aging: "ap_invoices",
  bank_reconciliation: "bank_recon",
  bank_recon_report: "bank_recon",
  // Financial reports → analytics (read/export module)
  trial_balance: "analytics",
  // Factor (Rosenthal) — Phase 2 added the chargeback-dispute write, so the
  // panel gates on finance_misc (matches the server's "factor" segment map).
  factor_recon: "finance_misc",
  income_statement: "analytics",
  balance_sheet: "analytics",
  cash_flow: "analytics",
  gl_detail: "analytics",
  sales_by_rep: "analytics",
  sales_by_customer: "analytics",
  // Procurement
  purchase_orders: "procurement",
  // 3-Way Match — payables control; server gates its routes on ap_invoices
  // (api/_lib/rbac/routePermissions.js "three-way-match" segment).
  three_way_match: "ap_invoices",
  // Inventory / ops
  inventory_transfers: "inventory",
  inventory_adjustments: "inventory",
  // Read-only on-hand accuracy monitor → analytics (read/export report class).
  inventory_accuracy: "analytics",
  cycle_counts: "inventory",
  scanner_sessions: "inventory",
  // Approvals / workflows
  approval_rules: "workflows",
  approval_requests: "workflows",
  // Notifications (the center; per-user prefs stay unmapped/visible)
  notifications: "notifications",
  // Marketplaces / mirror
  shadow_mirror: "parallel_run",
  shopify_refunds: "shopify",
  marketplace_status: "marketplaces",
  // Admin
  audit_log: "audit_log",
  user_access: "users_access",
};

// ── Vendor app (src/TandA.tsx View) → module_key ────────────────────────────
// Only the views that map to an existing module_key. The vendor portal predates
// P14 and most of its surfaces (scorecards, shipments, ESG, …) have no module
// yet → omitted → always visible.
export const VENDOR_VIEW_RBAC: Record<string, string> = {
  vendors: "vendor_master",
  onboarding: "vendor_master",
  preferred_vendors: "vendor_master",
  compliance: "compliance",
  compliance_automation: "compliance",
  compliance_audit: "compliance",
  sustainability: "compliance",
  rfqs: "sourcing",
  payments: "ap_payments",
  discount_offers: "finance_misc",
  scf: "finance_misc",
  virtual_cards: "finance_misc",
  fx: "finance_misc",
  tax: "finance_misc",
  analytics: "analytics",
  spend: "analytics",
  insights: "analytics",
  workflow_rules: "workflows",
  workflow_executions: "workflows",
  entities: "tenancy_admin",
};

/** Tangerine nav key → module_key, or null when unmapped (always visible). */
export function rbacModuleForTangerine(key: string): string | null {
  return TANGERINE_MODULE_RBAC[key] ?? null;
}

/** Vendor-app view → module_key, or null when unmapped (always visible). */
export function rbacModuleForVendorView(view: string): string | null {
  return VENDOR_VIEW_RBAC[view] ?? null;
}
