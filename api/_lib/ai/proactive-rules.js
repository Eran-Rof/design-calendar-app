// Rule-based proactive insight engine for Ask AI (Tier 3K).
//
// Hard-coded RULES detect "stuff worth flagging" from live data. The
// cron handler is a thin orchestrator: pull data → run rules → upsert
// any insights returned. New rules belong here.
//
// Design philosophy:
//   - RULES, not AI. False-positive risk is too high to let a model do
//     first detection. AI can be layered in later to phrase the alert
//     prettily once a rule fires.
//   - Floors + ratios, not raw thresholds. "Customer dropped 25%" alone
//     fires too often on tiny accounts; require both a % drop AND a $
//     floor so we only surface things the operator actually cares about.
//   - Dedupe keys baked in. The same signal should fire ONCE per week,
//     not every day until the operator dismisses it.
//
// Every rule's pure detection function is exported so it can be tested
// independently of any DB shape — feed it the aggregated input it would
// receive from the cron and check the output insights.

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * ISO date (YYYY-MM-DD) for a given Date — UTC year/month/date so the
 * dedupe key is stable across server timezones.
 */
function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Monday of the week containing `d` (UTC). Used as the dedupe-key date
 * for rules that should fire at most once per week.
 */
export function weekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = date.getUTCDay(); // 0..6, Sun..Sat
  const offset = (dow + 6) % 7; // Mon=0, Sun=6
  date.setUTCDate(date.getUTCDate() - offset);
  return isoDate(date);
}

/**
 * Round a number to N decimals. Used to keep metrics JSON readable.
 */
export function round(n, decimals = 1) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// ────────────────────────────────────────────────────────────────────────
// Rule 1 — Customer churn signal
// ────────────────────────────────────────────────────────────────────────

/**
 * Flags customers whose T30 (trailing 30 days) revenue dropped by
 * `dropThresholdPct` or more vs P30 (the 30 days before that), with
 * an absolute floor of `minPriorRevenue` on the P30 baseline.
 *
 * Input: Map<customer_id, { name?, t30Revenue, p30Revenue }>
 * Output: array of insight objects (no DB writes — the cron upserts them).
 */
export function detectCustomerChurnSignals(byCustomer, {
  dropThresholdPct = 25,
  minPriorRevenue = 10000,
  now = new Date(),
} = {}) {
  const thresholdRatio = (100 - dropThresholdPct) / 100;
  const insights = [];
  for (const [customerId, r] of byCustomer.entries()) {
    const prior   = Number(r.p30Revenue || 0);
    const current = Number(r.t30Revenue || 0);
    if (prior < minPriorRevenue) continue;            // small accounts → ignore
    if (current >= prior * thresholdRatio) continue;  // not enough drop
    const dropPct = round((1 - current / prior) * 100, 1);
    const dropDollars = Math.round(prior - current);
    const label = r.name || customerId;
    insights.push({
      rule: "customer_churn_signal",
      severity: dropPct >= 50 ? "urgent" : "warn",
      subject_type: "customer",
      subject_id: customerId,
      subject_label: label,
      headline: `${label} shipments down ${dropPct}% in the last 30 days (vs the 30 days prior)`,
      detail: `T30 revenue $${current.toLocaleString("en-US")} vs P30 $${prior.toLocaleString("en-US")} — a $${dropDollars.toLocaleString("en-US")} drop. Worth a check-in if this customer is normally steady.`,
      metrics: {
        t30_revenue: Math.round(current),
        p30_revenue: Math.round(prior),
        drop_pct: dropPct,
        drop_dollars: dropDollars,
      },
      dedupe_key: `customer_churn_signal:${customerId}:${weekKey(now)}`,
    });
  }
  // Most severe first.
  insights.sort((a, b) => b.metrics.drop_pct - a.metrics.drop_pct);
  return insights;
}

// ────────────────────────────────────────────────────────────────────────
// Rule 2 — Style runaway success (potential reorder candidate)
// ────────────────────────────────────────────────────────────────────────

/**
 * Flags styles whose T7 daily-average qty is materially HIGHER than
 * their T30 daily-average. Floor on T30 prevents flagging brand-new
 * styles where any sales look like a multiplier explosion.
 *
 * Input: Map<style_code, { t7Qty, t30Qty }>
 * Output: array of insight objects.
 */
export function detectStyleRunaways(byStyle, {
  multiplier = 2.5,
  minT30Qty = 50,
  topN = 5,
  now = new Date(),
} = {}) {
  const insights = [];
  for (const [style, r] of byStyle.entries()) {
    const t30Qty = Number(r.t30Qty || 0);
    const t7Qty  = Number(r.t7Qty || 0);
    if (t30Qty < minT30Qty) continue;
    const t7Daily  = t7Qty / 7;
    const t30Daily = t30Qty / 30;
    if (t30Daily <= 0) continue;
    if (t7Daily < t30Daily * multiplier) continue;
    const lift = round(t7Daily / t30Daily, 2);
    insights.push({
      rule: "style_runaway_success",
      severity: lift >= 4 ? "urgent" : "info",
      subject_type: "style",
      subject_id: style,
      subject_label: style,
      headline: `${style} selling ${lift}× faster this week than its trailing 30-day pace`,
      detail: `Last 7 days averaged ${round(t7Daily, 1)} units/day vs ${round(t30Daily, 1)} units/day over the trailing 30. Worth checking inventory/open POs before this empties out.`,
      metrics: {
        t7_qty: Math.round(t7Qty),
        t30_qty: Math.round(t30Qty),
        t7_daily: round(t7Daily, 2),
        t30_daily: round(t30Daily, 2),
        lift_x: lift,
      },
      dedupe_key: `style_runaway_success:${style}:${weekKey(now)}`,
    });
  }
  insights.sort((a, b) => b.metrics.lift_x - a.metrics.lift_x);
  return insights.slice(0, topN);
}

// ────────────────────────────────────────────────────────────────────────
// Rule 3 — Style declining hard while open POs in flight
// ────────────────────────────────────────────────────────────────────────

/**
 * Flags styles whose T7 daily-average has collapsed to ≤ `maxRatio`
 * of T30 daily-average AND that have non-trivial open-PO exposure.
 * The "open PO" criterion is what makes it actionable — pure decline
 * with no incoming inventory is just a reporting fact, not a decision.
 *
 * Input: Map<style_code, { t7Qty, t30Qty, openPoQty }>
 */
export function detectStyleDeclines(byStyle, {
  maxRatio = 0.3,
  minT30Qty = 100,
  minOpenPoQty = 50,
  topN = 5,
  now = new Date(),
} = {}) {
  const insights = [];
  for (const [style, r] of byStyle.entries()) {
    const t30Qty = Number(r.t30Qty || 0);
    const t7Qty  = Number(r.t7Qty || 0);
    const openPoQty = Number(r.openPoQty || 0);
    if (t30Qty < minT30Qty) continue;
    if (openPoQty < minOpenPoQty) continue;
    const t7Daily  = t7Qty / 7;
    const t30Daily = t30Qty / 30;
    if (t30Daily <= 0) continue;
    const ratio = t7Daily / t30Daily;
    if (ratio > maxRatio) continue;
    const dropPct = round((1 - ratio) * 100, 1);
    insights.push({
      rule: "style_declining_with_open_po",
      severity: "warn",
      subject_type: "style",
      subject_id: style,
      subject_label: style,
      headline: `${style} sell-through collapsed (down ${dropPct}% vs T30 pace) — ${Math.round(openPoQty)} units still on order`,
      detail: `Last 7 days averaged ${round(t7Daily, 1)} units/day vs ${round(t30Daily, 1)} over the trailing 30. With ${Math.round(openPoQty)} units still inbound on open POs, this is a cancellation/reduction candidate.`,
      metrics: {
        t7_qty: Math.round(t7Qty),
        t30_qty: Math.round(t30Qty),
        t7_daily: round(t7Daily, 2),
        t30_daily: round(t30Daily, 2),
        drop_pct: dropPct,
        open_po_qty: Math.round(openPoQty),
      },
      dedupe_key: `style_declining_with_open_po:${style}:${weekKey(now)}`,
    });
  }
  insights.sort((a, b) => b.metrics.drop_pct - a.metrics.drop_pct);
  return insights.slice(0, topN);
}
