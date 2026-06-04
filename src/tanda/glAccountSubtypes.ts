// src/tanda/glAccountSubtypes.ts
//
// Canonical GL account-subtype master — the controlled vocabulary for
// gl_accounts.account_subtype. Single source of truth so the COA form writes
// consistent values and financial reports can group/subtotal by subtype
// (e.g. current vs fixed assets, COGS vs OpEx) instead of free-text drift.
//
// Keyed by account_type. Extend here (and reports pick it up) rather than
// typing ad-hoc strings into the account form.

export type SubtypeOption = { value: string; label: string };

export const SUBTYPES_BY_TYPE: Record<string, SubtypeOption[]> = {
  asset: [
    { value: "cash_and_equivalents", label: "Cash & equivalents" },
    { value: "accounts_receivable", label: "Accounts receivable" },
    { value: "inventory", label: "Inventory" },
    { value: "prepaid_expense", label: "Prepaid expense" },
    { value: "current_asset", label: "Other current asset" },
    { value: "fixed_asset", label: "Fixed asset (PP&E)" },
    { value: "intangible_asset", label: "Intangible asset" },
    { value: "other_asset", label: "Other asset" },
  ],
  contra_asset: [
    { value: "accumulated_depreciation", label: "Accumulated depreciation" },
    { value: "allowance_doubtful_accounts", label: "Allowance for doubtful accounts" },
    { value: "inventory_reserve", label: "Inventory reserve" },
  ],
  liability: [
    { value: "accounts_payable", label: "Accounts payable" },
    { value: "accrued_liability", label: "Accrued liability" },
    { value: "credit_card", label: "Credit card" },
    { value: "deferred_revenue", label: "Deferred revenue" },
    { value: "taxes_payable", label: "Taxes payable" },
    { value: "current_liability", label: "Other current liability" },
    { value: "long_term_liability", label: "Long-term liability" },
    { value: "other_liability", label: "Other liability" },
  ],
  equity: [
    { value: "contributed_capital", label: "Contributed capital" },
    { value: "retained_earnings", label: "Retained earnings" },
    { value: "owners_equity", label: "Owner's equity / draws" },
    { value: "other_equity", label: "Other equity" },
  ],
  revenue: [
    { value: "product_revenue", label: "Product revenue" },
    { value: "service_revenue", label: "Service revenue" },
    { value: "operating_revenue", label: "Other operating revenue" },
    { value: "other_revenue", label: "Non-operating / other revenue" },
  ],
  contra_revenue: [
    { value: "sales_returns", label: "Sales returns" },
    { value: "sales_discounts", label: "Sales discounts / allowances" },
    { value: "chargebacks", label: "Chargebacks" },
  ],
  expense: [
    { value: "cogs", label: "Cost of goods sold (COGS)" },
    { value: "payroll_expense", label: "Payroll & benefits" },
    { value: "marketing_expense", label: "Marketing & advertising" },
    { value: "gna_expense", label: "General & administrative" },
    { value: "operating_expense", label: "Other operating expense" },
    { value: "depreciation_expense", label: "Depreciation & amortization" },
    { value: "interest_expense", label: "Interest expense" },
    { value: "tax_expense", label: "Income tax expense" },
    { value: "other_expense", label: "Non-operating / other expense" },
  ],
};

/** Options for a given account_type (empty array if unknown type). */
export function subtypeOptionsFor(accountType: string): SubtypeOption[] {
  return SUBTYPES_BY_TYPE[accountType] || [];
}

/** Human label for a stored subtype value (falls back to the raw value). */
export function subtypeLabel(value: string | null | undefined): string {
  if (!value) return "";
  for (const opts of Object.values(SUBTYPES_BY_TYPE)) {
    const hit = opts.find((o) => o.value === value);
    if (hit) return hit.label;
  }
  return value;
}
