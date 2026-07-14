// src/lib/xoroReconCategory.ts
//
// Pure categorization logic for the monthly Xoro↔Tangerine TB recon
// (#xoro-recon-monthly-v2). This mirrors, 1:1, the CASE in the SQL view
// v_xoro_tangerine_tb_recon (migration 20260991000000) so the client can
// re-derive / validate a break's category and so the rule is unit-tested in
// isolation. The view computes break_category server-side; this is the single
// documented source of truth for what each category MEANS and how it's decided.
//
// A row is one (month, ROF COA code). Signed net-debit convention throughout
// (+ = debit). Components:
//   variance              = xoro_net_debit − tang_net_debit  (Xoro minus the ACTUAL Tangerine GL)
//   reclass_net_debit     = the channel_reclass JE component of tang (intentional, §6 gl-rebuild-provenance)
//   xoro_unmirrored_debit = the slice of xoro_net_debit whose Xoro txn has no mirror JE yet (open-period lag)
//   residual_core         = variance + reclass_net_debit − xoro_unmirrored_debit
//                           (what remains once the intentional reclass and the not-yet-mirrored legs
//                            are accounted for → ~0 when the break is fully explained)

export type ReconCategory =
  | "clean"
  | "intentional_divergence"
  | "missing_txn"
  | "unmapped"
  | "excluded_by_design"
  | "unexplained";

export interface ReconComponents {
  variance: number;
  residual_core: number;
  xoro_unmirrored_debit: number;
  reclass_net_debit: number;
}

/** $1.00 absolute — matches the rebuild's per-txn 8001 Penny-Rounding routing. */
export const CLEAN_TOLERANCE = 1.0;

/**
 * Tolerance for deciding a >$1 break is fully EXPLAINED (by reclass or by
 * not-yet-mirrored legs): $1.00 floor OR 0.5% of the break, whichever is larger.
 * The relative term lets a $1.87 residual on a $39K open-period gap read as the
 * missing_txn it is, while a genuine $2.95 penny with no explanation stays
 * visible as 'unexplained'.
 */
export function explainedTolerance(variance: number): number {
  return Math.max(CLEAN_TOLERANCE, 0.005 * Math.abs(variance));
}

/**
 * Categorize one recon account-month. Identical precedence to the SQL view:
 * clean → missing_txn → intentional_divergence → unexplained.
 * ('unmapped' and 'excluded_by_design' are produced upstream of this function —
 * unmapped rows have no ROF code to compare, and nothing is excluded after the
 * full GL rebuild — so they are part of the enum but not decided here.)
 */
export function categorizeReconRow(c: ReconComponents): ReconCategory {
  const v = Math.abs(c.variance);
  if (v <= CLEAN_TOLERANCE) return "clean";
  const tol = explainedTolerance(c.variance);
  const explained = Math.abs(c.residual_core) <= tol;
  if (explained && Math.abs(c.xoro_unmirrored_debit) > 0.01) return "missing_txn";
  if (explained && Math.abs(c.reclass_net_debit) > 0.01) return "intentional_divergence";
  return "unexplained";
}

/** Display metadata per category — label, one-line meaning, tone for the UI. */
export const RECON_CATEGORY_META: Record<
  ReconCategory,
  { label: string; tone: "ok" | "info" | "warn" | "bad" | "muted"; blurb: string }
> = {
  clean: { label: "Clean", tone: "ok", blurb: "Tangerine ties to Xoro within $1." },
  intentional_divergence: {
    label: "Intentional",
    tone: "info",
    blurb: "channel_reclass split (revenue/COGS-internal, net-zero) — see gl-rebuild provenance §6.",
  },
  missing_txn: {
    label: "Open-period lag",
    tone: "warn",
    blurb: "Xoro txns not yet mirrored by the nightly GL sync — self-heals; only ever the current open month.",
  },
  unmapped: {
    label: "Unmapped",
    tone: "warn",
    blurb: "Xoro account name with no ROF COA mapping (currently none — map is 100%).",
  },
  excluded_by_design: {
    label: "Excluded",
    tone: "muted",
    blurb: "Documented mirror exclusion (currently none — the full rebuild mirrors everything).",
  },
  unexplained: { label: "Unexplained", tone: "bad", blurb: "A break with no accounted-for cause — investigate." },
};

/** Categories that do NOT count against a clean close (informational / self-healing). */
export const NON_BREAK_CATEGORIES: ReconCategory[] = ["clean", "intentional_divergence", "excluded_by_design"];

/** True when a category should block a month-close green check. */
export function isCloseBlocking(cat: ReconCategory): boolean {
  return !NON_BREAK_CATEGORIES.includes(cat);
}
