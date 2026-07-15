// src/lib/budget.ts
//
// Tangerine FP&A — pure budget-vs-actual math (no I/O, fully unit-tested).
//
// The variance/favorability rules here MUST match the SQL RPC budget_vs_actual
// (mig 20261030000000, fixed 20261070000000) so the panel, the statement Budget
// column and the DB all agree. Everything is in TRUE integer cents; account
// "actuals" are the same signed convention the Income Statement uses (revenue =
// CR−DR, contra_revenue = DR−CR, expense = DR−CR), i.e. each account type reads
// as a POSITIVE magnitude in its natural direction (revenue positive income,
// expense positive cost).
//
// IMPORTANT — the "actuals" fed to the seed are OPERATING activity only: the SQL
// RPC excludes year-end CLOSING entries (any JE that posts to an equity /
// retained-earnings account), because a closing entry debits revenue and credits
// expenses to nil, which over a full closed year would net a revenue account's
// CR−DR to ≈ 0. Excluding them restores each P&L account's natural-direction
// magnitude — that is the fix for "seed populated some expenses but no revenue"
// (mig 20261070000000). seedRowsFromActuals therefore NEVER drops or sign-filters
// a row: every income-statement account provided must produce exactly one budget
// row, so revenue can never silently disappear.

/** GL account types that appear on the P&L. */
export type PnlAccountType = "revenue" | "contra_revenue" | "expense";

/**
 * Variance in cents = actual − budget (signed). Positive means actual came in
 * ABOVE budget (more revenue, or more cost — direction interpreted by
 * `isFavorable`). Inputs are rounded to whole cents first so callers can pass
 * fractional intermediates safely.
 */
export function varianceCents(actualCents: number, budgetCents: number): number {
  return Math.round(actualCents || 0) - Math.round(budgetCents || 0);
}

/**
 * Variance as a percent of the (absolute) budget, or null when budget is 0
 * (an infinite/undefined percentage — the UI renders "—").
 */
export function variancePct(actualCents: number, budgetCents: number): number | null {
  const b = Math.round(budgetCents || 0);
  if (b === 0) return null;
  return (varianceCents(actualCents, budgetCents) / Math.abs(b)) * 100;
}

/**
 * Sign-aware favorability. Revenue is favorable when actual meets or beats
 * budget; costs (expense) and revenue deductions (contra_revenue) are favorable
 * when actual is at or below budget.
 */
export function isFavorable(accountType: string, actualCents: number, budgetCents: number): boolean {
  const v = varianceCents(actualCents, budgetCents);
  if (accountType === "revenue") return v >= 0;
  return v <= 0; // expense, contra_revenue
}

/**
 * Whether a POSITIVE (actual − budget) variance is the favorable direction for
 * this account type. Lets the UI colour a variance cell without re-deriving the
 * numbers: true → green when positive, false → green when negative. Income-like
 * roll-ups (Net Sales, Gross Profit, Net Income) pass "revenue".
 */
export function favorableWhenPositive(accountType: string): boolean {
  return accountType === "revenue";
}

/**
 * Expand a stored budget row into a 12-element per-month array (index 0 = Jan),
 * mirroring v_gl_budget_monthly: period 0 (full-year) spreads evenly (rounded to
 * the cent); period 1..12 places the whole amount in that single month.
 */
export function expandBudgetToMonths(amountCents: number, periodNumber: number): number[] {
  const out = new Array<number>(12).fill(0);
  const amt = Math.round(amountCents || 0);
  if (periodNumber === 0) {
    const per = Math.round(amt / 12);
    for (let i = 0; i < 12; i++) out[i] = per;
  } else if (periodNumber >= 1 && periodNumber <= 12) {
    out[periodNumber - 1] = amt;
  }
  return out;
}

/**
 * Apply a growth percentage to an actual amount (cents), rounded to the cent.
 * growthPct is a whole-number percent: 5 → +5%, -10 → −10%.
 */
export function grownBudgetCents(actualCents: number, growthPct: number): number {
  return Math.round((actualCents || 0) * (1 + (growthPct || 0) / 100));
}

export type ActualSeedInput = { gl_account_id: string; amount_cents: number };
export type SeededBudgetRow = { gl_account_id: string; period_number: number; amount_cents: number };

/**
 * Draft budget rows from a set of prior-year actuals × growth. The reference
 * implementation for the seed_budget_from_actuals RPC (annual grain): one
 * full-year (period 0) row per account, prior-year actual × (1 + growth%).
 *
 * Skips ONLY rows without an account id. It deliberately does NOT sign-filter or
 * drop any row: every income-statement account (revenue, contra_revenue, COGS,
 * expense) whose actual is provided gets exactly one budget row, so revenue —
 * whose natural magnitude is a positive CREDIT — can never be silently dropped
 * (the PR #1779 regression, root-caused to closing entries; see mig
 * 20261070000000 and the module header). Zero and negative actuals are preserved
 * verbatim so budget ≈ actual reconciles at 0% growth.
 */
export function seedRowsFromActuals(actuals: ActualSeedInput[], growthPct: number): SeededBudgetRow[] {
  return actuals
    .filter((a) => a && a.gl_account_id)
    .map((a) => ({
      gl_account_id: a.gl_account_id,
      period_number: 0,
      amount_cents: grownBudgetCents(a.amount_cents, growthPct),
    }));
}
