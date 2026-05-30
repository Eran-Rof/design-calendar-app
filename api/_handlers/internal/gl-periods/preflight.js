// api/internal/gl-periods/:id/preflight
//
// GET. Returns the rows from gl_period_close_preflight() for this period
// (one row per check, with check_name + status + detail + blocking).
//
// Used by the Periods panel "Run checks" button (P5-7). The close handler
// (P5-1) also calls this RPC internally and rejects 409 when any blocking
// row has status='fail' (unless ?ignore_warnings=true on close).
//
// Tangerine P5-7 (original) + P12-99 (marketplace deposit augmentation).
//
// P12-99 augmentation (close-out for marketplaces):
//   After the SQL RPC runs we also query the four marketplace deposit
//   tables — shopify_payouts, fba_settlements, walmart_settlements,
//   faire_payouts — for rows landing in the period whose je_id IS NULL.
//   Any unmatched deposit produces a BLOCKING check row called
//   `unmatched_marketplace_deposits` with a per-table count breakdown in
//   the detail. Period D6 (Marketplace Receivable Clearing) cannot square
//   if a deposit lands in the period without a clearing JE.
//   This lives in JS — no new migration per chunk constraints.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function summarize(rows) {
  const out = {
    total: rows.length,
    passed: 0,
    failed_blocking: 0,
    failed_warnings: 0,
    can_close: true,
  };
  for (const r of rows) {
    if (r.status === "pass") {
      out.passed += 1;
    } else if (r.blocking) {
      out.failed_blocking += 1;
      out.can_close = false;
    } else {
      out.failed_warnings += 1;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// P12-99 marketplace deposits augmentation
// ─────────────────────────────────────────────────────────────────────────
//
// The four channel-deposit tables have different date columns; we use the
// per-table column that anchors the deposit to a business date:
//
//   shopify_payouts      → payout_date  (date)
//   fba_settlements      → posted_after (timestamptz; truncated to date)
//   walmart_settlements  → period_end   (date)
//   faire_payouts        → period_end   (date)
//
// A row is "unmatched" when je_id IS NULL — the bank-recon match engine
// stamps je_id once the clearing JE has been posted. Anything landing
// on/before period.ends_on with je_id NULL means D6 (1115 Marketplace
// Receivable Clearing) cannot be reconciled — block the close.

export const MARKETPLACE_DEPOSIT_TABLES = [
  { table: "shopify_payouts",     dateColumn: "payout_date",  label: "Shopify"  },
  { table: "fba_settlements",     dateColumn: "posted_after", label: "FBA"      },
  { table: "walmart_settlements", dateColumn: "period_end",   label: "Walmart"  },
  { table: "faire_payouts",       dateColumn: "period_end",   label: "Faire"    },
];

// Run one count(je_id IS NULL) query per deposit table for rows landing in
// the period. Resilient: an undefined-table error (channel migration not
// applied) is treated as zero rather than blocking the operator.
//
// `admin` is a Supabase service-role client; `period` is the gl_periods row.
// Returns { perTable: { shopify_payouts: 12, ... }, total: 17, errors: [] }.
export async function countUnmatchedMarketplaceDeposits(admin, period) {
  const perTable = {};
  const errors = [];
  let total = 0;

  for (const { table, dateColumn } of MARKETPLACE_DEPOSIT_TABLES) {
    perTable[table] = 0;
    try {
      let q = admin
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("entity_id", period.entity_id)
        .is("je_id", null);

      // Marketplace deposit checks are landed-on-or-before period.ends_on.
      // The architecture spec says unmatched deposits dated *within or
      // before* the period are a close blocker (a late deposit that
      // arrived during the period but couldn't be matched still has to
      // clear before the period itself closes).
      if (dateColumn === "posted_after") {
        // timestamptz — compare to end of period day inclusive
        q = q.lte(dateColumn, `${period.ends_on}T23:59:59.999Z`);
      } else {
        q = q.lte(dateColumn, period.ends_on);
      }

      const { count, error } = await q;
      if (error) {
        // Most common: table doesn't exist yet (migration not applied
        // for this env). Treat as zero — don't block close on it.
        const msg = String(error.message || "").toLowerCase();
        if (
          msg.includes("does not exist") ||
          msg.includes("undefined_table") ||
          msg.includes("could not find the table")
        ) {
          perTable[table] = 0;
          continue;
        }
        errors.push({ table, error: error.message });
        continue;
      }
      const n = typeof count === "number" ? count : 0;
      perTable[table] = n;
      total += n;
    } catch (e) {
      errors.push({ table, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { perTable, total, errors };
}

// ─────────────────────────────────────────────────────────────────────────
// P9-8 unresolved recon variances augmentation
// ─────────────────────────────────────────────────────────────────────────
//
// Per arch §3.4: period close should surface (and soft-block) when any
// reconciliation domain has an unresolved variance for the period being
// closed. "Unresolved" means a recon_run with status='variance' whose
// period_end <= preflight.period.ends_on AND no SUBSEQUENT clean run
// for the same (domain, period_start, period_end) tuple exists.
//
// Pre-cutover (parallel_run_status[domain] in {'parallel','xoro_truth'}
// or absent) this is a SOFT block per D4 — surfaced to the operator
// but `blocking:false` so they can still soft-close. After P9-9 sign-off
// flips parallel_run_status[domain] to 'tangerine_solo' / 'tangerine_truth',
// the same check becomes a HARD block (blocking:true). This chunk seeds
// the SOFT path; P9-9 will branch on cutover state.
//
// Returns { perDomain: {ap:N, ar:N, ...}, total: int, errors: [], sampleRuns:[] }.

export const RECON_DOMAINS = ["ap", "ar", "cash", "gl", "inventory"];

export async function countUnresolvedReconVariances(admin, period) {
  const perDomain = {};
  const errors = [];
  const sampleRuns = [];
  let total = 0;

  for (const domain of RECON_DOMAINS) {
    perDomain[domain] = 0;
  }

  try {
    // Fetch every recon_run for this (entity, period_end window). We
    // need both variance and any later runs to dedupe: a domain that
    // had a variance run on Monday and a clean re-run on Tuesday for
    // the same (period_start, period_end) is resolved.
    const { data, error } = await admin
      .from("recon_runs")
      .select("id, domain, status, period_start, period_end, completed_at, started_at, totals_jsonb")
      .eq("entity_id", period.entity_id)
      .lte("period_end", period.ends_on)
      .order("completed_at", { ascending: false });
    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (
        msg.includes("does not exist") ||
        msg.includes("undefined_table") ||
        msg.includes("could not find the table")
      ) {
        // P9-1 migration not applied → nothing to check; treat as 0.
        return { perDomain, total: 0, errors: [], sampleRuns: [] };
      }
      errors.push({ scope: "recon_runs_read", error: error.message });
      return { perDomain, total: 0, errors, sampleRuns: [] };
    }

    // Group by (domain, period_start, period_end). Within each group,
    // the most recent (sorted DESC by completed_at) wins. If that
    // latest run is status='variance' it's unresolved.
    const latestByKey = new Map();
    for (const row of data || []) {
      const key = `${row.domain}::${row.period_start}::${row.period_end}`;
      if (!latestByKey.has(key)) {
        latestByKey.set(key, row);
      }
    }
    for (const row of latestByKey.values()) {
      if (row.status !== "variance") continue;
      if (!RECON_DOMAINS.includes(row.domain)) continue;
      perDomain[row.domain] += 1;
      total += 1;
      if (sampleRuns.length < 10) {
        sampleRuns.push({
          recon_run_id: row.id,
          domain: row.domain,
          period_start: row.period_start,
          period_end: row.period_end,
        });
      }
    }
  } catch (e) {
    errors.push({ scope: "recon_runs_read", error: e instanceof Error ? e.message : String(e) });
  }

  return { perDomain, total, errors, sampleRuns };
}

// Compose the single preflight row from an unresolved-recon snapshot.
// Pre-cutover this is a SOFT block (blocking:false). After P9-9 sign-off
// flips entities.parallel_run_status[domain].status to 'solo', the same
// check becomes a HARD block (blocking:true) — operators can't close a
// period that still carries unresolved variances on a domain Tangerine
// is now authoritative for.
//
// Behavior:
//   - blocking = true  iff ANY domain in the snapshot.perDomain map
//                       has at least one unresolved variance AND that
//                       domain is in 'solo' status on the entity.
//   - blocking = false otherwise (pre-cutover / parallel mode).
export function buildUnresolvedReconRow(snapshot, soloDomains = []) {
  if (snapshot.total === 0) {
    return {
      check_name: "unresolved_recon_variances",
      status: "pass",
      detail: "No unresolved Parallel-Run reconciliation variances at or before period end",
      blocking: false,
    };
  }
  const soloSet = new Set(Array.isArray(soloDomains) ? soloDomains : []);
  const domainsWithVariances = RECON_DOMAINS.filter(
    (d) => (snapshot.perDomain[d] || 0) > 0,
  );
  const soloDomainsWithVariances = domainsWithVariances.filter((d) =>
    soloSet.has(d),
  );
  const parallelDomainsWithVariances = domainsWithVariances.filter(
    (d) => !soloSet.has(d),
  );
  const parts = domainsWithVariances.map(
    (d) =>
      `${d.toUpperCase()}: ${snapshot.perDomain[d]}${soloSet.has(d) ? " (post-cutover)" : ""}`,
  );

  const blocking = soloDomainsWithVariances.length > 0;
  const detailHead = `${snapshot.total} unresolved Parallel-Run reconciliation variance${snapshot.total === 1 ? "" : "s"} at or before period end — ${parts.join(", ")}.`;
  let detailTail;
  if (blocking) {
    detailTail =
      ` ${soloDomainsWithVariances.map((d) => d.toUpperCase()).join(", ")} ` +
      `${soloDomainsWithVariances.length === 1 ? "is" : "are"} post-cutover (solo) — period cannot close with open variances on a domain Tangerine is authoritative for. ` +
      `Open InternalReconciliationDashboard to triage.`;
    if (parallelDomainsWithVariances.length > 0) {
      detailTail +=
        ` Parallel-run domains (${parallelDomainsWithVariances.map((d) => d.toUpperCase()).join(", ")}) remain advisory until their own cutover sign-off.`;
    }
  } else {
    detailTail =
      ` Open InternalReconciliationDashboard to triage. Advisory until per-domain cutover sign-off (P9-9).`;
  }

  return {
    check_name: "unresolved_recon_variances",
    status: "fail",
    detail: `${detailHead}${detailTail}`,
    blocking,
  };
}

// Read entities.parallel_run_status and return the list of recon
// domains currently in 'solo' status. Best-effort: any error returns
// an empty list (treat as pre-cutover, soft-block).
export async function fetchSoloDomains(admin, entity_id) {
  if (!entity_id) return [];
  try {
    const { data, error } = await admin
      .from("entities")
      .select("parallel_run_status")
      .eq("id", entity_id)
      .maybeSingle();
    if (error || !data) return [];
    const blob = data.parallel_run_status;
    if (!blob || typeof blob !== "object") return [];
    const out = [];
    for (const d of RECON_DOMAINS) {
      const entry = blob[d];
      if (entry && typeof entry === "object" && entry.status === "solo") {
        out.push(d);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Compose the single preflight row from a deposit-count snapshot.
export function buildMarketplaceDepositsRow(snapshot) {
  if (snapshot.total === 0) {
    return {
      check_name: "unmatched_marketplace_deposits",
      status: "pass",
      detail: "No unmatched marketplace deposits landing in this period",
      blocking: true,
    };
  }
  const parts = MARKETPLACE_DEPOSIT_TABLES
    .filter(({ table }) => (snapshot.perTable[table] || 0) > 0)
    .map(({ table, label }) => `${label} (${table}): ${snapshot.perTable[table]}`);
  return {
    check_name: "unmatched_marketplace_deposits",
    status: "fail",
    detail: `${snapshot.total} marketplace deposit${snapshot.total === 1 ? "" : "s"} unmatched (je_id IS NULL) at or before period end — ${parts.join(", ")}. Run bank-reconciliation matcher before close.`,
    blocking: true,
  };
}

// End-to-end: run the SQL RPC, then augment with the marketplace deposit
// row. Returns the full row list plus the summary. Used both by this
// handler and by the close handler.
export async function runPreflight(admin, period) {
  const { data: rpcRows, error: rpcErr } = await admin.rpc("gl_period_close_preflight", {
    p_entity_id: period.entity_id,
    p_period_id: period.id,
  });
  if (rpcErr) {
    return { error: rpcErr.message, rows: [], summary: summarize([]) };
  }
  const rows = Array.isArray(rpcRows) ? [...rpcRows] : [];

  // Marketplace deposits augmentation — only if the period has an
  // ends_on (always true in practice; defensive).
  if (period.ends_on) {
    const snapshot = await countUnmatchedMarketplaceDeposits(admin, period);
    rows.push(buildMarketplaceDepositsRow(snapshot));

    // P9-8 / P9-9: unresolved recon variances.
    //   - Pre-cutover (parallel mode): soft-block (advisory only).
    //   - Post-cutover (parallel_run_status[domain].status === 'solo'):
    //     hard-block if there's an unresolved variance on the cut-over
    //     domain — the operator can't close a period with open variances
    //     on a domain Tangerine is now authoritative for.
    const reconSnap = await countUnresolvedReconVariances(admin, period);
    const soloDomains = await fetchSoloDomains(admin, period.entity_id);
    rows.push(buildUnresolvedReconRow(reconSnap, soloDomains));
  }

  return { rows, summary: summarize(rows) };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Resolve entity_id from the period (the RPC takes both).
  const { data: period, error: pErr } = await admin
    .from("gl_periods")
    .select("id, entity_id, fiscal_year, period_number, status, starts_on, ends_on")
    .eq("id", id)
    .maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: "Period not found" });

  const result = await runPreflight(admin, period);
  if (result.error) return res.status(500).json({ error: result.error });

  return res.status(200).json({
    period_id: id,
    period: {
      fiscal_year: period.fiscal_year,
      period_number: period.period_number,
      status: period.status,
      starts_on: period.starts_on,
      ends_on: period.ends_on,
    },
    rows: result.rows,
    summary: result.summary,
  });
}
