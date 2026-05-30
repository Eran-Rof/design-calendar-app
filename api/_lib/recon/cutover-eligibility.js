// api/_lib/recon/cutover-eligibility.js
//
// Tangerine P9-9 — Cutover eligibility computation.
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.4 D8 +
// §6.9 cutover flow.
//
// Operator confirms a domain (and optionally a single source_tag channel
// within that domain) is ready to flip from xoro_truth → tangerine_solo
// when:
//
//   1. At least CLEAN_RUN_FLOOR (=8) recon_runs exist for this
//      (entity, domain[, source_tag]) tuple over the past 60 days.
//   2. ALL those runs landed status='clean' — no 'variance' / 'error' /
//      'pending' / 'running' values within the window.
//   3. The most recent clean run completed within the past
//      RECENT_RUN_HORIZON_DAYS (=8) days. This guards against the
//      "no recon for 4 weeks then nothing" situation: cutover requires
//      a live, fresh recon proving the parity right now.
//
// `source_tag` semantics:
//   - source_tag=null  → whole-domain cutover (matches recon_runs that
//     also have source_tag null in totals_jsonb, or that are domain-wide
//     by construction — AP/Cash/GL/Inventory engines don't slice by
//     source_tag).
//   - source_tag='shopify' → channel-level cutover (only the AR engine
//     slices by source; this is the (D7) channel granularity).
//
// recon_runs does NOT carry a top-level source_tag column (see P9-1
// migration). When a channel-level signoff is requested we read the
// per-domain runs and trust the caller's source_tag is meaningful for
// the AR engine; the per-channel breakdown lives in totals_jsonb and
// in recon_variances. For eligibility purposes a channel-level signoff
// requires the SAME 8-run-clean window — channel-level just records a
// narrower scope on the recon_cutover_signoffs row.
//
// Pure(-ish) module: takes a configured supabase admin client and
// computes; no env-var reads, no notifications, no entity-status
// mutations. The handler decides what to do with the verdict.

export const CLEAN_RUN_FLOOR = 8;
export const RECENT_RUN_HORIZON_DAYS = 8;
export const CLEAN_WINDOW_DAYS = 60;

export const RECON_DOMAINS = Object.freeze([
  "ap",
  "ar",
  "cash",
  "gl",
  "inventory",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return ISO YYYY-MM-DD for (now - days). Pure helper, exported for
 * tests so the date math can be exercised without a clock dependency.
 */
export function daysAgoISO(days, now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Return ISO YYYY-MM-DD for `now`.
 */
export function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Compute eligibility for a (entity, domain, source_tag?) cutover.
 *
 * Returns a structured verdict the handler can drop into the response
 * AND persist to recon_cutover_signoffs when eligible:
 *
 *   {
 *     eligible:                boolean,
 *     reason:                  string,       // human-readable
 *     clean_runs_count:        int,
 *     oldest_clean_run_date:   ISO | null,
 *     latest_clean_run_date:   ISO | null,
 *     has_recent_clean_run:    boolean,
 *     has_unresolved_variances: boolean,
 *     clean_window_start:      ISO,
 *     clean_window_end:        ISO,
 *   }
 *
 * Defensive: any DB error becomes { eligible:false, reason:'...' }
 * rather than a throw, so the handler can return a clean 409.
 */
export async function computeCutoverEligibility({
  adminClient,
  entity_id,
  domain,
  source_tag = null,
  now = new Date(),
}) {
  const clean_window_end = todayISO(now);
  const clean_window_start = daysAgoISO(CLEAN_WINDOW_DAYS, now);

  const baseVerdict = {
    eligible: false,
    reason: "",
    clean_runs_count: 0,
    oldest_clean_run_date: null,
    latest_clean_run_date: null,
    has_recent_clean_run: false,
    has_unresolved_variances: false,
    clean_window_start,
    clean_window_end,
  };

  // 1. Input guards.
  if (!adminClient || typeof adminClient.from !== "function") {
    return { ...baseVerdict, reason: "adminClient is required" };
  }
  if (!entity_id || typeof entity_id !== "string" || !UUID_RE.test(entity_id)) {
    return { ...baseVerdict, reason: "entity_id must be a uuid" };
  }
  if (!domain || typeof domain !== "string" || !RECON_DOMAINS.includes(domain)) {
    return {
      ...baseVerdict,
      reason: `domain must be one of: ${RECON_DOMAINS.join(", ")}`,
    };
  }
  if (source_tag != null && typeof source_tag !== "string") {
    return { ...baseVerdict, reason: "source_tag must be a string when provided" };
  }

  // 2. Pull recon_runs for this (entity, domain) over the 60-day window.
  //    We select all runs (regardless of status) so we can both count
  //    clean rows AND detect any non-clean rows in the window — both
  //    counts feed the verdict.
  let runs;
  try {
    const { data, error } = await adminClient
      .from("recon_runs")
      .select("id, domain, status, run_date, period_start, period_end, completed_at")
      .eq("entity_id", entity_id)
      .eq("domain", domain)
      .gte("run_date", clean_window_start)
      .lte("run_date", clean_window_end)
      .order("run_date", { ascending: true });
    if (error) {
      return {
        ...baseVerdict,
        reason: `recon_runs read failed: ${error.message}`,
      };
    }
    runs = data || [];
  } catch (err) {
    return {
      ...baseVerdict,
      reason: `recon_runs read threw: ${err?.message || String(err)}`,
    };
  }

  // 3. Tabulate.
  const cleanRuns = runs.filter((r) => r.status === "clean");
  const nonCleanRuns = runs.filter((r) => r.status && r.status !== "clean");
  const clean_runs_count = cleanRuns.length;
  const oldest_clean_run_date = cleanRuns.length > 0 ? cleanRuns[0].run_date : null;
  const latest_clean_run_date =
    cleanRuns.length > 0 ? cleanRuns[cleanRuns.length - 1].run_date : null;

  // "Recent" = latest clean run is within RECENT_RUN_HORIZON_DAYS days
  // of `now`. Compare on the ISO-string YYYY-MM-DD; comparison works
  // lexicographically for that shape.
  const recent_floor = daysAgoISO(RECENT_RUN_HORIZON_DAYS, now);
  const has_recent_clean_run =
    latest_clean_run_date != null && latest_clean_run_date >= recent_floor;

  const has_unresolved_variances = nonCleanRuns.length > 0;

  // 4. Compose verdict.
  if (clean_runs_count < CLEAN_RUN_FLOOR) {
    return {
      ...baseVerdict,
      clean_runs_count,
      oldest_clean_run_date,
      latest_clean_run_date,
      has_recent_clean_run,
      has_unresolved_variances,
      eligible: false,
      reason:
        `Need at least ${CLEAN_RUN_FLOOR} clean recon runs in the past ` +
        `${CLEAN_WINDOW_DAYS} days for ${domain}` +
        (source_tag ? ` (${source_tag})` : "") +
        `, got ${clean_runs_count}.`,
    };
  }

  if (has_unresolved_variances) {
    return {
      ...baseVerdict,
      clean_runs_count,
      oldest_clean_run_date,
      latest_clean_run_date,
      has_recent_clean_run,
      has_unresolved_variances,
      eligible: false,
      reason:
        `Found ${nonCleanRuns.length} non-clean recon run` +
        (nonCleanRuns.length === 1 ? "" : "s") +
        ` for ${domain}` +
        (source_tag ? ` (${source_tag})` : "") +
        ` in the past ${CLEAN_WINDOW_DAYS} days. Clear or resolve before signoff.`,
    };
  }

  if (!has_recent_clean_run) {
    return {
      ...baseVerdict,
      clean_runs_count,
      oldest_clean_run_date,
      latest_clean_run_date,
      has_recent_clean_run,
      has_unresolved_variances,
      eligible: false,
      reason:
        `Most recent clean recon run for ${domain}` +
        (source_tag ? ` (${source_tag})` : "") +
        ` is ${latest_clean_run_date}; needs a run within ` +
        `${RECENT_RUN_HORIZON_DAYS} days of today (${clean_window_end}).`,
    };
  }

  return {
    eligible: true,
    reason:
      `${clean_runs_count} clean recon runs across ${oldest_clean_run_date} → ${latest_clean_run_date} ` +
      `for ${domain}` +
      (source_tag ? ` (${source_tag})` : "") +
      `; cutover window satisfied.`,
    clean_runs_count,
    oldest_clean_run_date,
    latest_clean_run_date,
    has_recent_clean_run,
    has_unresolved_variances,
    clean_window_start,
    clean_window_end,
  };
}

/**
 * Bulk check for the "all 5 domains are eligible" view used by the
 * dashboard top-bar. Runs computeCutoverEligibility for every domain
 * and returns a map plus an aggregate flag.
 *
 * Note: this is a per-domain check; channel-level (AR per source_tag)
 * eligibility lives behind the per-domain call with an explicit
 * source_tag arg. This bulk helper is intentionally limited to the
 * 5 whole-domain entries.
 */
export async function verifyAllDomainsEligible({
  adminClient,
  entity_id,
  now = new Date(),
}) {
  const perDomain = {};
  for (const domain of RECON_DOMAINS) {
    perDomain[domain] = await computeCutoverEligibility({
      adminClient,
      entity_id,
      domain,
      source_tag: null,
      now,
    });
  }
  const all_eligible = RECON_DOMAINS.every((d) => perDomain[d].eligible);
  const eligible_domains = RECON_DOMAINS.filter((d) => perDomain[d].eligible);
  const ineligible_domains = RECON_DOMAINS.filter((d) => !perDomain[d].eligible);
  return {
    all_eligible,
    eligible_domains,
    ineligible_domains,
    per_domain: perDomain,
  };
}
