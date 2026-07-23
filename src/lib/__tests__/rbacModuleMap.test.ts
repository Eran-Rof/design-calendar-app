// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  rbacModuleForTangerine,
  rbacModuleForVendorView,
  TANGERINE_MODULE_RBAC,
} from "../rbacModuleMap";

// The valid P14-1 module_keys (mirrors the seed in the chunk-1 migration,
// plus keys registered by later migrations — beta_data: 20266100000000).
const MODULE_KEYS = new Set([
  "style_master", "product_master", "vendor_master", "customer_master", "coa",
  "gl_periods", "je_entry", "je_post", "ar_invoices", "ar_receipts", "ap_invoices",
  "ap_payments", "bank_recon", "inventory", "po_wip", "procurement", "ats",
  "sales_comps", "costing", "gs1", "tech_pack", "shopify", "marketplaces",
  "parallel_run", "workflows", "notifications", "users_access", "audit_log",
  "analytics", "compliance", "sourcing", "finance_misc", "tenancy_admin",
  "beta_data",
]);

describe("rbacModuleMap", () => {
  it("maps known Tangerine nav keys to real module_keys", () => {
    expect(rbacModuleForTangerine("gl_accounts")).toBe("coa");
    expect(rbacModuleForTangerine("journal_entries")).toBe("je_entry");
    expect(rbacModuleForTangerine("user_access")).toBe("users_access");
    expect(rbacModuleForTangerine("trial_balance")).toBe("analytics");
  });

  it("returns null for unmapped keys (always-visible fail-open)", () => {
    expect(rbacModuleForTangerine("employees")).toBeNull();
    expect(rbacModuleForTangerine("crm_tasks")).toBeNull();
    expect(rbacModuleForTangerine("payment_terms")).toBeNull();
    expect(rbacModuleForTangerine("nonexistent")).toBeNull();
  });

  it("every mapped target is a real module_key (no typos)", () => {
    for (const target of Object.values(TANGERINE_MODULE_RBAC)) {
      expect(MODULE_KEYS.has(target)).toBe(true);
    }
  });

  it("maps known vendor views, null otherwise", () => {
    expect(rbacModuleForVendorView("rfqs")).toBe("sourcing");
    expect(rbacModuleForVendorView("entities")).toBe("tenancy_admin");
    expect(rbacModuleForVendorView("scorecards")).toBeNull(); // no module yet
  });
});
