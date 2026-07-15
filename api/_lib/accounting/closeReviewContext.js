// api/_lib/accounting/closeReviewContext.js
//
// Month-End Close — per-manual-item REVIEW CONTEXT (#close-manual-review-links).
//
// The 6 manual checklist items (bank statements, factor statement, chargebacks,
// payroll, depreciation, controller sign-off) used to pop a blind "What was
// reviewed?" prompt with no hint of WHAT to review. This helper computes, for
// each manual item, a one-line plain-language summary + a count/figure for the
// period + the Tangerine module to open so the operator can actually review
// before signing.
//
// buildManualReviewContext(admin, entityId, period, month, items?) returns a map
//   { [item_key]: { summary, panel, drill?, count?, severity } | null }
// attached to each manual item as item.review by the checklist GET.
//
// Rules honored:
//   • Every count is 1000-row-cap-safe — head:true exact counts / bounded
//     aggregates, never fetch-then-count on unbounded tables.
//   • Period-scoped by the table's date column where one exists (noted per item).
//   • Empty/absent/erroring source → graceful "no data" summary, never throws.
//   • panel is a Tangerine module key (verified in api/_lib/tangerineModules.js);
//     panel:null (controller sign-off) = no single drill target.

import { formatUsd } from "./tieouts.js";

/** "2026-05" → "05/2026" (US display). */
export function monthLabel(month) {
  const [y, mo] = String(month).split("-");
  return `${mo}/${y}`;
}

/** First day of the month AFTER `month`, as YYYY-MM-DD (exclusive upper bound). */
export function nextMonthStart(month) {
  const [y, m] = String(month).split("-").map(Number);
  // Date.UTC month is 0-based, so passing `m` (1-based) yields the next month.
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

function plural(n) {
  return n === 1 ? "" : "s";
}

// ── Per-item builders ────────────────────────────────────────────────────────
// Each returns { summary, panel, drill?, count?, severity } and swallows its own
// errors into a graceful summary so one bad source never breaks the checklist.

/**
 * chargebacks_reviewed → Chargeback Management worklist.
 * Counts factor_chargebacks still in disposition='open' for the close month.
 * Period-scoped by report_month (a DATE column, always the 1st of the month),
 * so an exact equality on period.starts_on is the natural scope.
 */
export async function chargebacksContext(admin, entityId, startsOn, monthLbl) {
  const panel = "chargebacks";
  try {
    const { count, error } = await admin
      .from("factor_chargebacks")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", entityId)
      .eq("report_month", startsOn)
      .eq("disposition", "open");
    if (error) throw new Error(error.message);
    const n = count || 0;
    return {
      summary: n > 0
        ? `${n} open chargeback${plural(n)} to review for ${monthLbl}`
        : `No open chargebacks for ${monthLbl}`,
      panel,
      drill: { cb_disposition: "open", cb_month: startsOn.slice(0, 7) },
      count: n,
      severity: n > 0 ? "warn" : "info",
    };
  } catch {
    return { summary: "Chargeback data unavailable — open the panel to review", panel, severity: "info" };
  }
}

/**
 * bank_statements_reviewed → Bank Reconciliation.
 * Counts unmatched bank_transactions in the close month.
 * Period-scoped by posted_date (a DATE column) using a [start, nextMonth) range.
 */
export async function bankContext(admin, entityId, startsOn, endExclusive, monthLbl) {
  const panel = "bank_reconciliation";
  try {
    const { count, error } = await admin
      .from("bank_transactions")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", entityId)
      .eq("status", "unmatched")
      .gte("posted_date", startsOn)
      .lt("posted_date", endExclusive);
    if (error) throw new Error(error.message);
    const n = count || 0;
    return {
      summary: n > 0
        ? `${n} unreconciled bank transaction${plural(n)} in ${monthLbl}`
        : `All bank transactions reconciled in ${monthLbl}`,
      panel,
      count: n,
      severity: n > 0 ? "warn" : "info",
    };
  } catch {
    return { summary: "Bank data unavailable — open the panel to review", panel, severity: "info" };
  }
}

/**
 * factor_statement_reconciled → Factor (Rosenthal) recon.
 * Checks whether a factor_statements row covers the month (statement_month is the
 * 1st of the month — same scope the auto factor_recon check uses).
 */
export async function factorContext(admin, entityId, startsOn, monthLbl) {
  const panel = "factor_recon";
  try {
    const { data, error } = await admin
      .from("factor_statements")
      .select("id, ending_net_oar_cents")
      .eq("entity_id", entityId)
      .eq("statement_month", startsOn)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      return {
        summary: `Factor statement for ${monthLbl} imported — reconcile ending Net OAR (${formatUsd(data.ending_net_oar_cents)}) to GL 1107`,
        panel,
        count: 1,
        severity: "info",
      };
    }
    return {
      summary: `No factor statement imported for ${monthLbl} yet`,
      panel,
      count: 0,
      severity: "warn",
    };
  } catch {
    return { summary: "Factor data unavailable — open the panel to review", panel, severity: "info" };
  }
}

/**
 * payroll_booked → Journal Entries.
 * Counts posted payroll JEs in the month. Payroll is mirrored from Xoro as
 * source_module='payroll' (journal_type 'xoro_gl_mirror', #1716).
 * Period-scoped by posting_date [start, nextMonth).
 */
export async function payrollContext(admin, entityId, startsOn, endExclusive, monthLbl) {
  const panel = "journal_entries";
  try {
    const { count, error } = await admin
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", entityId)
      .eq("source_module", "payroll")
      .eq("status", "posted")
      .gte("posting_date", startsOn)
      .lt("posting_date", endExclusive);
    if (error) throw new Error(error.message);
    const n = count || 0;
    return {
      summary: n > 0
        ? `${n} payroll JE${plural(n)} posted in ${monthLbl}`
        : `No payroll JE booked for ${monthLbl}`,
      panel,
      count: n,
      severity: n > 0 ? "info" : "warn",
    };
  } catch {
    return { summary: "Payroll data unavailable — open the panel to review", panel, severity: "info" };
  }
}

/**
 * depreciation_booked → Fixed Assets.
 * Reports the depreciation schedule for the month. Native GL posting is gated
 * off until Xoro cutover (Xoro mirrors depreciation into the GL we mirror), so
 * the sign-off confirms the mirrored booking against the schedule rather than a
 * native post. Period-scoped by fixed_asset_depreciation.period_date; entity via
 * the fixed_assets!inner join. The schedule is inherently one row per asset per
 * month (well under the 1000-row cap), so we fetch to total the amount.
 */
export async function depreciationContext(admin, entityId, startsOn, endExclusive, monthLbl) {
  const panel = "fixed_assets";
  try {
    const { data, error } = await admin
      .from("fixed_asset_depreciation")
      .select("amount_cents, fixed_assets!inner(entity_id)")
      .eq("fixed_assets.entity_id", entityId)
      .gte("period_date", startsOn)
      .lt("period_date", endExclusive)
      .limit(1000);
    if (error) throw new Error(error.message);
    const rows = data || [];
    const n = rows.length;
    if (n === 0) {
      return {
        summary: `No depreciation scheduled for ${monthLbl}`,
        panel,
        count: 0,
        severity: "info",
      };
    }
    const total = rows.reduce((s, r) => s + (Number(r.amount_cents) || 0), 0);
    return {
      summary: `Depreciation of ${formatUsd(total)} scheduled across ${n} asset${plural(n)} for ${monthLbl} — confirm booked`,
      panel,
      count: n,
      severity: "info",
    };
  } catch {
    return { summary: "Fixed-asset data unavailable — open the panel to review", panel, severity: "info" };
  }
}

/**
 * controller_signoff → no single drill (final attestation).
 * Rolls up whether anything is still outstanding: auto blockers (stored
 * status='fail') + unsigned prior manual items. Uses the already-fetched
 * checklist items so there is no extra query.
 */
export function controllerContext(items) {
  const panel = null;
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return {
      summary: "Final attestation — certify once all checks pass and every item is signed off",
      panel,
      severity: "info",
    };
  }
  const blockers = list.filter((i) => i.kind === "auto" && i.status === "fail").length;
  const pendingManual = list.filter(
    (i) => i.kind === "manual" && i.item_key !== "controller_signoff" && i.status !== "signed_off",
  ).length;
  const outstanding = blockers + pendingManual;
  if (outstanding === 0) {
    return {
      summary: "All automated checks pass and every prior item is signed off — ready to certify the close",
      panel,
      count: 0,
      severity: "info",
    };
  }
  return {
    summary: `Resolve ${outstanding} outstanding item${plural(outstanding)} first — ${blockers} blocker${plural(blockers)}, ${pendingManual} unsigned sign-off${plural(pendingManual)}`,
    panel,
    count: outstanding,
    severity: "warn",
  };
}

/**
 * Build the per-manual-item review-context map.
 *
 * @param {object} admin     supabase service client
 * @param {string} entityId  entities.id (ROF)
 * @param {object} period    gl_periods row (needs starts_on)
 * @param {string} month     "YYYY-MM"
 * @param {Array}  [items]   already-fetched checklist items (for the controller roll-up)
 * @returns {Promise<Record<string, object|null>>}
 */
export async function buildManualReviewContext(admin, entityId, period, month, items = []) {
  const startsOn = period?.starts_on || `${month}-01`;
  const endExclusive = nextMonthStart(month);
  const monthLbl = monthLabel(month);

  const [chargebacks, bank, factor, payroll, depreciation] = await Promise.all([
    chargebacksContext(admin, entityId, startsOn, monthLbl),
    bankContext(admin, entityId, startsOn, endExclusive, monthLbl),
    factorContext(admin, entityId, startsOn, monthLbl),
    payrollContext(admin, entityId, startsOn, endExclusive, monthLbl),
    depreciationContext(admin, entityId, startsOn, endExclusive, monthLbl),
  ]);

  return {
    chargebacks_reviewed: chargebacks,
    bank_statements_reviewed: bank,
    factor_statement_reconciled: factor,
    payroll_booked: payroll,
    depreciation_booked: depreciation,
    controller_signoff: controllerContext(items),
  };
}

// ── AUTO-check review context ────────────────────────────────────────────────
// The 8 automated checks already carry their computed numbers in the stored
// detail jsonb (produced by the close_run_auto_checks SQL RPC — money math in
// SQL so the 1000-row cap never truncates a tie-out). So — unlike the manual
// builders, which each query a live source — the auto builders DERIVE their
// one-line review summary from that detail and add the panel to open + (for the
// two high-value cases) a filtered drill. No re-computation, so they can never
// disagree with the verdict they annotate. The one DB touch is resolving the
// 8007 gl_accounts.id to seed the GL-Detail drill; everything else is pure.
//
// A Review link is emitted regardless of pass/fail so the operator can always
// inspect the underlying item(s); severity is taken from the check's own rich
// classification (fail → critical, warn → warn, else info).

/** Number → US money string from cents (reuses tieouts.formatUsd). */
function usd(cents) {
  return formatUsd(cents);
}

/** Rich verdict → link severity. */
function autoSeverity(detail) {
  const cls = String((detail || {}).classification || "");
  if (cls === "fail") return "critical";
  if (cls === "warn") return "warn";
  return "info"; // pass / waived / unknown
}

/** gl_balanced → Journal Entries. Imbalance figures from detail. */
export function glBalancedContext(detail, monthLbl) {
  const panel = "journal_entries";
  try {
    const d = detail || {};
    const accrual = Number(d.accrual_imbalance_cents) || 0;
    const cash = Number(d.cash_imbalance_cents) || 0;
    const jes = Number(d.posted_je_count) || 0;
    const balanced = accrual === 0 && cash === 0;
    return {
      summary: balanced
        ? `Debits equal credits across ${jes} posted JE${plural(jes)} in ${monthLbl}`
        : `ACCRUAL off ${usd(accrual)} · CASH off ${usd(cash)} across ${jes} posted JE${plural(jes)} — review the period's entries`,
      panel,
      count: jes,
      severity: autoSeverity(d),
    };
  } catch {
    return { summary: "GL balance detail unavailable — open Journal Entries to review", panel, severity: "info" };
  }
}

/** ar_subledger_tie → AR Aging. Per-account diffs from detail.accounts[]. */
export function arTieContext(detail, monthLbl) {
  const panel = "ar_aging";
  try {
    const d = detail || {};
    const accts = Array.isArray(d.accounts) ? d.accounts : [];
    const off = accts.filter((a) => a && a.ok === false);
    if (off.length === 0) {
      return {
        summary: `AR subledger ties to GL (1105 / 1107 / 1108) as of ${monthLbl}`,
        panel,
        count: 0,
        severity: autoSeverity(d),
      };
    }
    const parts = off.map((a) => `${a.account_code} off ${usd(a.diff_cents)}`).join(" · ");
    return {
      summary: `AR out of tie for ${monthLbl}: ${parts} — reconcile to the aging`,
      panel,
      count: off.length,
      severity: autoSeverity(d),
    };
  } catch {
    return { summary: "AR tie detail unavailable — open AR Aging to review", panel, severity: "info" };
  }
}

/** ap_subledger_tie → AP Aging. GL vs open bills from detail. */
export function apTieContext(detail, monthLbl) {
  const panel = "ap_aging";
  try {
    const d = detail || {};
    const gl = Number(d.gl_cents) || 0;
    const sub = Number(d.subledger_cents) || 0;
    const diff = Number(d.diff_cents) || 0;
    const waived = d.waived ? " (waived: payments ledger not live)" : "";
    return {
      summary: diff === 0 && !d.waived
        ? `AP subledger ties to GL 2000 for ${monthLbl}`
        : `AP GL ${usd(gl)} vs open bills ${usd(sub)} → off ${usd(diff)}${waived} for ${monthLbl}`,
      panel,
      count: diff === 0 ? 0 : 1,
      severity: autoSeverity(d),
    };
  } catch {
    return { summary: "AP tie detail unavailable — open AP Aging to review", panel, severity: "info" };
  }
}

/** bank_recon → Bank Reconciliation. Reconciled/total account-months from detail. */
export function bankReconContext(detail, monthLbl) {
  const panel = "bank_reconciliation";
  try {
    const d = detail || {};
    const runs = Number(d.runs) || 0;
    const reconciled = Number(d.reconciled) || 0;
    const unreconciled = Math.max(runs - reconciled, 0);
    const note = d.waiver === "not_operated" ? " — reconciled in Xoro, not yet operated in Tangerine" : "";
    return {
      summary: `${reconciled}/${runs} bank/CC account-month${plural(runs)} reconciled for ${monthLbl}${note}`,
      panel,
      count: unreconciled,
      severity: autoSeverity(d),
    };
  } catch {
    return { summary: "Bank recon detail unavailable — open Bank Reconciliation to review", panel, severity: "info" };
  }
}

/**
 * no_draft_jes → Journal Entries, FILTERED to drafts. The highest-value drill:
 * seeds ?include_drafts=true so the panel opens with unposted entries shown.
 * draft count from detail.draft_je_count.
 */
export function draftJesContext(detail, monthLbl) {
  const panel = "journal_entries";
  try {
    const d = detail || {};
    const n = Number(d.draft_je_count) || 0;
    return {
      summary: n > 0
        ? `${n} draft/unposted JE${plural(n)} to post or delete in ${monthLbl}`
        : `No draft/unposted JEs in ${monthLbl}`,
      panel,
      drill: n > 0 ? { include_drafts: "true" } : undefined,
      count: n,
      severity: autoSeverity(d),
    };
  } catch {
    return { summary: "Draft-JE detail unavailable — open Journal Entries to review", panel, severity: "info" };
  }
}

/**
 * uncategorized_8007 → GL Detail, FILTERED to account 8007 for the period.
 * Seeds ?account_id=<8007 uuid>&from=<start>&to=<end> (the deep-link the GL
 * Detail panel already reads). `drill` is passed in by the builder after the
 * one account-id lookup; activity figures come from detail.
 */
export function uncat8007Context(detail, monthLbl, drill) {
  const panel = "gl_detail";
  try {
    const d = detail || {};
    const net = Number(d.accrual_net_cents) || 0;
    const lines = Number(d.line_count) || 0;
    return {
      summary: lines > 0
        ? `8007 activity ${usd(net)} across ${lines} line${plural(lines)} in ${monthLbl} — recategorize`
        : `No Uncategorized Expense (8007) activity in ${monthLbl}`,
      panel,
      drill: lines > 0 && drill ? drill : undefined,
      count: lines,
      severity: autoSeverity(d),
    };
  } catch {
    return { summary: "8007 detail unavailable — open GL Detail to review", panel, severity: "info" };
  }
}

/** factor_recon → Factor (Rosenthal). Coverage + Net OAR vs GL 1107 from detail. */
export function factorReconContext(detail, monthLbl) {
  const panel = "factor_recon";
  try {
    const d = detail || {};
    if (d.covered === false) {
      return {
        summary: `No factor statement covers ${monthLbl}`,
        panel,
        count: 0,
        severity: autoSeverity(d),
      };
    }
    const oar = Number(d.ending_net_oar_cents) || 0;
    const gl = Number(d.gl_1107_asof_cents) || 0;
    const diff = Number(d.diff_cents) || 0;
    return {
      summary: diff === 0
        ? `Factor Net OAR ${usd(oar)} ties to GL 1107 for ${monthLbl}`
        : `Factor Net OAR ${usd(oar)} vs GL 1107 ${usd(gl)} → off ${usd(diff)} for ${monthLbl}`,
      panel,
      count: 1,
      severity: autoSeverity(d),
    };
  } catch {
    return { summary: "Factor recon detail unavailable — open Factor (Rosenthal) to review", panel, severity: "info" };
  }
}

/** revenue_posted → Income Statement. Revenue figure from detail. */
export function revenuePostedContext(detail, monthLbl) {
  const panel = "income_statement";
  try {
    const d = detail || {};
    const rev = Number(d.revenue_cents) || 0;
    return {
      summary: `Revenue posted ${usd(rev)} for ${monthLbl}`,
      panel,
      count: undefined,
      severity: autoSeverity(d),
    };
  } catch {
    return { summary: "Revenue detail unavailable — open the Income Statement to review", panel, severity: "info" };
  }
}

/**
 * Resolve the gl_accounts.id for account code 8007 (entity-scoped) so the
 * uncategorized_8007 review can deep-link GL Detail to that account. Best-effort
 * — a null id just means the drill opens GL Detail without a pre-selected
 * account (the summary still carries the figure). Never throws.
 */
export async function resolve8007AccountId(admin, entityId) {
  try {
    const { data, error } = await admin
      .from("gl_accounts")
      .select("id")
      .eq("entity_id", entityId)
      .eq("code", "8007")
      .maybeSingle();
    if (error || !data) return null;
    return data.id || null;
  } catch {
    return null;
  }
}

/**
 * Build the per-AUTO-item review-context map from the already-fetched auto
 * checklist items (each carries its computed detail jsonb). Mirrors
 * buildManualReviewContext: returns { [item_key]: {summary,panel,drill?,count?,severity} }.
 *
 * @param {object} admin      supabase service client (only for the 8007 lookup)
 * @param {string} entityId   entities.id (ROF)
 * @param {object} period     gl_periods row (needs starts_on / ends_on)
 * @param {string} month      "YYYY-MM"
 * @param {Array}  autoItems  the kind='auto' checklist items (with .detail)
 * @returns {Promise<Record<string, object|null>>}
 */
export async function buildAutoReviewContext(admin, entityId, period, month, autoItems = []) {
  const monthLbl = monthLabel(month);
  const startsOn = period?.starts_on || `${month}-01`;
  const endsOn = period?.ends_on || nextMonthStart(month);
  const byKey = new Map((Array.isArray(autoItems) ? autoItems : []).map((i) => [i.item_key, i.detail || {}]));

  // Only resolve the 8007 account id when there is 8007 activity to drill into.
  const has8007 = Number((byKey.get("uncategorized_8007") || {}).line_count) > 0;
  const acct8007 = has8007 ? await resolve8007AccountId(admin, entityId) : null;
  const gl8007Drill = acct8007 ? { account_id: acct8007, from: startsOn, to: endsOn } : undefined;

  return {
    gl_balanced: glBalancedContext(byKey.get("gl_balanced"), monthLbl),
    ar_subledger_tie: arTieContext(byKey.get("ar_subledger_tie"), monthLbl),
    ap_subledger_tie: apTieContext(byKey.get("ap_subledger_tie"), monthLbl),
    bank_recon: bankReconContext(byKey.get("bank_recon"), monthLbl),
    no_draft_jes: draftJesContext(byKey.get("no_draft_jes"), monthLbl),
    uncategorized_8007: uncat8007Context(byKey.get("uncategorized_8007"), monthLbl, gl8007Drill),
    factor_recon: factorReconContext(byKey.get("factor_recon"), monthLbl),
    revenue_posted: revenuePostedContext(byKey.get("revenue_posted"), monthLbl),
  };
}
