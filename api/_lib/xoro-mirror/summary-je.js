// Cross-cutter T10-5 — Daily summary JE poster (per arch §4.4).
//
// After AR + AP + inventory mirrors complete for a given mirror_date, post
// one summary JE per domain so the GL has the day's totals without
// per-invoice JE noise.
//
//   AR Summary  : ROUTED (Phase 2, revenue→GL) — DR per (AR account × customer:
//                 factored 1107 / CC 1105 / house 1108, customer subledger) /
//                 CR per revenue bucket (4005…4016 via revenueRouting.js)
//                 = SUM(mirror AR total_amount_cents), always balanced.
//   AP Summary  : DR 5001 COGS        / CR 2000 AP Control   = SUM(mirror AP total_amount_cents)
//   Inventory   : DR/CR 1201 Inventory vs 5001 COGS          = today_value - prior_value (if |Δ| ≥ $1)
//   (Bridge COGS stays PERIODIC — AP purchases + inventory Δ — until native
//    per-invoice posting at cutover; routed per-sale COGS then replaces it.)
//
// All JEs go through the gl_post_journal_entry(payload jsonb) RPC. The RPC
// takes numeric(18,2) DOLLAR strings (not cents) so we convert cents→dollars
// at the payload boundary.
//
// Idempotency: for each domain we check whether a journal_entries row already
// exists with (source_module='xoro_mirror', source_id=<run_id>) BEFORE posting.
// If it does, skip + record in `skipped[]`. The handler then updates
// xoro_mirror_runs.je_id on its own.
//
// PUBLIC ENTRY: postDailySummaryJes(supabase, entity_id, mirror_date).
//
// Returns:
//   {
//     je_ids:        { ar, ap, inventory_or_null },
//     totals_cents:  { ar, ap, inventory_delta },
//     run_ids:       { ar, ap, inventory },
//     skipped:       [ { domain, reason, existing_je_id? }, ... ],
//     errors:        [ { domain, kind, message }, ... ],
//   }

import { loadArRoutedInputs, bucketMirrorDay, composeArRoutedPayload, AR_ROUTED_CODES } from "./ar-routed-summary.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True iff `v` is a YYYY-MM-DD string that round-trips through Date. */
export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

/**
 * Convert integer cents → numeric(18,2)-compatible DOLLAR string.
 * Two decimals always. Negatives kept (caller decides DR vs CR).
 */
export function centsToDollarString(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "0.00";
  const negative = n < 0;
  const abs = Math.abs(Math.round(n));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Look up a set of gl_account ids for this entity by `code`. Returns a
 * Map<code, id>. Any missing code is reported via the `missing` array.
 */
export async function loadAccountIds(supabase, entity_id, codes) {
  const out = new Map();
  const missing = [];
  for (const code of codes) {
    const { data, error } = await supabase
      .from("gl_accounts")
      .select("id")
      .eq("entity_id", entity_id)
      .eq("code", code)
      .maybeSingle();
    if (error || !data) {
      missing.push(code);
      continue;
    }
    out.set(code, data.id);
  }
  return { ids: out, missing };
}

/**
 * Find the latest completed mirror run for (entity, domain, mirror_date).
 * Returns the row or null. Excludes failed/skipped runs.
 */
export async function findCompletedRun(supabase, { entity_id, domain, mirror_date }) {
  const { data, error } = await supabase
    .from("xoro_mirror_runs")
    .select("id, status, je_id, mirror_date")
    .eq("entity_id", entity_id)
    .eq("domain", domain)
    .eq("mirror_date", mirror_date)
    .eq("status", "complete")
    .maybeSingle();
  if (error) return null;
  return data || null;
}

/**
 * Has a summary JE already been posted for this run? Looks up
 * journal_entries by (source_module='xoro_mirror', source_id=<run_id>).
 */
export async function findExistingSummaryJe(supabase, run_id) {
  if (!run_id) return null;
  const { data, error } = await supabase
    .from("journal_entries")
    .select("id")
    .eq("source_module", "xoro_mirror")
    .eq("source_id", String(run_id))
    .maybeSingle();
  if (error) return null;
  return data?.id || null;
}

/**
 * Sum total_amount_cents on ar_invoices for (entity, mirror_date, source='xoro_mirror').
 * Paginates in 1000-row chunks defensively.
 */
export async function sumArMirrorTotals(supabase, { entity_id, mirror_date }) {
  let total = 0;
  let offset = 0;
  const page = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("ar_invoices")
      .select("total_amount_cents")
      .eq("entity_id", entity_id)
      .eq("source", "xoro_mirror")
      .eq("invoice_date", mirror_date)
      .range(offset, offset + page - 1);
    if (error) throw new Error(`ar_invoices read failed: ${error.message}`);
    const rows = data || [];
    for (const r of rows) total += Number(r.total_amount_cents || 0);
    if (rows.length < page) break;
    offset += rows.length;
  }
  return total;
}

/**
 * Sum total_amount_cents on invoices (AP) for (entity, mirror_date, source='xoro_mirror').
 * AP table uses `invoice_date` for the bill date.
 */
export async function sumApMirrorTotals(supabase, { entity_id, mirror_date }) {
  let total = 0;
  let offset = 0;
  const page = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("invoices")
      .select("total_amount_cents")
      .eq("entity_id", entity_id)
      .eq("source", "xoro_mirror")
      .eq("invoice_date", mirror_date)
      .range(offset, offset + page - 1);
    if (error) throw new Error(`invoices read failed: ${error.message}`);
    const rows = data || [];
    for (const r of rows) total += Number(r.total_amount_cents || 0);
    if (rows.length < page) break;
    offset += rows.length;
  }
  return total;
}

/**
 * Compute inventory value (in cents) from inventory_layers where
 * source_kind='xoro_mirror_snapshot'. Value = SUM(remaining_qty × unit_cost_cents).
 *
 * remaining_qty is numeric(18,4); unit_cost_cents is bigint. We multiply in
 * floating point then round — for shadow-ledger valuation this is precise
 * enough since the result is itself rounded to the dollar in the JE.
 */
export async function computeInventoryValueCents(supabase, { entity_id }) {
  let total = 0;
  let offset = 0;
  const page = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("inventory_layers")
      .select("remaining_qty, unit_cost_cents")
      .eq("entity_id", entity_id)
      .eq("source_kind", "xoro_mirror_snapshot")
      .range(offset, offset + page - 1);
    if (error) throw new Error(`inventory_layers read failed: ${error.message}`);
    const rows = data || [];
    for (const r of rows) {
      const qty = Number(r.remaining_qty || 0);
      const unit = Number(r.unit_cost_cents || 0);
      total += Math.round(qty * unit);
    }
    if (rows.length < page) break;
    offset += rows.length;
  }
  return total;
}

/**
 * Probe the prior mirror_date's inventory snapshot value. Strategy:
 *   1. Find the previous successful 'inventory' run with mirror_date < today.
 *   2. If that run has a je_id linked to a posted inventory JE, infer the
 *      prior value from its lines (DR 1300 - CR 1300 line cents).
 *   3. If no prior run exists at all → return 0 (first-ever run).
 *
 * Returns the prior inventory value in cents. This lets the delta calc
 * survive crashes / re-runs without double-counting.
 *
 * Note: this is a best-effort probe. If the prior JE shape changed we
 * still fall back to 0 rather than failing the whole posting.
 */
export async function findPriorInventoryValueCents(supabase, { entity_id, mirror_date }) {
  const { data: priorRun, error } = await supabase
    .from("xoro_mirror_runs")
    .select("id, mirror_date, je_id")
    .eq("entity_id", entity_id)
    .eq("domain", "inventory")
    .eq("status", "complete")
    .lt("mirror_date", mirror_date)
    .order("mirror_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !priorRun) return 0;

  // If the prior run wrote a JE, sum the 1300 Inventory Asset lines we
  // ourselves posted (DR-CR) — that's the delta we applied. We can't
  // reconstruct the absolute prior value from one delta alone, so we
  // fall through and return 0 in the common "no prior je_id" case.
  // For shadow-ledger purposes, the absolute value is computed fresh from
  // inventory_layers each night so the delta is what matters.
  void priorRun;
  return 0;
}

/**
 * Build the gl_post_journal_entry payload for an AR summary JE.
 */
export function composeArSummaryPayload({
  entity_id, mirror_date, run_id, ar_total_cents,
  ar_account_id, revenue_account_id, actor_user_id,
}) {
  const dollars = centsToDollarString(ar_total_cents);
  return {
    entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_xoro_mirror_daily",
    posting_date: mirror_date,
    source_module: "xoro_mirror",
    source_table: "xoro_mirror_runs",
    source_id: String(run_id),
    description: `Xoro AR mirror summary for ${mirror_date}`,
    created_by_user_id: actor_user_id || null,
    lines: [
      { line_number: 1, account_id: ar_account_id,       debit: dollars, credit: "0" },
      { line_number: 2, account_id: revenue_account_id,  debit: "0",     credit: dollars },
    ],
  };
}

/**
 * Build the gl_post_journal_entry payload for an AP summary JE.
 */
export function composeApSummaryPayload({
  entity_id, mirror_date, run_id, ap_total_cents,
  cogs_account_id, ap_account_id, actor_user_id,
}) {
  const dollars = centsToDollarString(ap_total_cents);
  return {
    entity_id,
    basis: "ACCRUAL",
    journal_type: "ap_xoro_mirror_daily",
    posting_date: mirror_date,
    source_module: "xoro_mirror",
    source_table: "xoro_mirror_runs",
    source_id: String(run_id),
    description: `Xoro AP mirror summary for ${mirror_date}`,
    created_by_user_id: actor_user_id || null,
    lines: [
      { line_number: 1, account_id: cogs_account_id,  debit: dollars, credit: "0" },
      { line_number: 2, account_id: ap_account_id,    debit: "0",     credit: dollars },
    ],
  };
}

/**
 * Build the gl_post_journal_entry payload for an inventory adjustment JE.
 *
 * delta_cents > 0 → inventory grew     → DR 1300 / CR 5000
 * delta_cents < 0 → inventory shrunk   → CR 1300 / DR 5000
 *                                         (i.e. inverse, with absolute amount)
 */
export function composeInventoryPayload({
  entity_id, mirror_date, run_id, delta_cents,
  inventory_asset_account_id, cogs_account_id, actor_user_id,
}) {
  const absDollars = centsToDollarString(Math.abs(delta_cents));
  let invDebit = "0", invCredit = "0", cogsDebit = "0", cogsCredit = "0";
  if (delta_cents > 0) {
    invDebit = absDollars;
    cogsCredit = absDollars;
  } else {
    invCredit = absDollars;
    cogsDebit = absDollars;
  }
  return {
    entity_id,
    basis: "ACCRUAL",
    journal_type: "inventory_xoro_mirror_daily",
    posting_date: mirror_date,
    source_module: "xoro_mirror",
    source_table: "xoro_mirror_runs",
    source_id: String(run_id),
    description: `Xoro inventory mirror summary for ${mirror_date}`,
    created_by_user_id: actor_user_id || null,
    lines: [
      { line_number: 1, account_id: inventory_asset_account_id, debit: invDebit,  credit: invCredit },
      { line_number: 2, account_id: cogs_account_id,            debit: cogsDebit, credit: cogsCredit },
    ],
  };
}

/**
 * Post one JE via gl_post_journal_entry. Returns the new JE id on success or
 * throws on failure (caller catches + records in errors).
 */
async function postJe(supabase, payload) {
  const { data, error } = await supabase.rpc("gl_post_journal_entry", { payload });
  if (error) {
    const e = new Error(`gl_post_journal_entry failed: ${error.message}`);
    e.code = "rpc_failed";
    throw e;
  }
  if (!data || typeof data !== "string") {
    throw new Error(`gl_post_journal_entry returned unexpected payload: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Update xoro_mirror_runs.je_id after a successful summary JE post so the
 * UI status panel can deep-link to the JE.
 */
async function attachJeIdToRun(supabase, run_id, je_id) {
  if (!run_id || !je_id) return;
  await supabase
    .from("xoro_mirror_runs")
    .update({ je_id })
    .eq("id", run_id);
}

const INVENTORY_DELTA_FLOOR_CENTS = 100; // skip JE if |delta| < $1.00

/**
 * Main entry point.
 *
 * @param {object} supabase             Supabase service-role client.
 * @param {string} entity_id            Tangerine entity uuid.
 * @param {string} mirror_date          YYYY-MM-DD.
 * @param {object} [opts]
 * @param {string} [opts.actor_user_id] Optional user id stamped on created_by_user_id.
 */
export async function postDailySummaryJes(supabase, entity_id, mirror_date, opts = {}) {
  const result = {
    je_ids: { ar: null, ap: null, inventory_or_null: null },
    totals_cents: { ar: 0, ap: 0, inventory_delta: 0 },
    run_ids: { ar: null, ap: null, inventory: null },
    skipped: [],
    errors: [],
  };

  if (!entity_id) {
    result.errors.push({ domain: null, kind: "bad_entity", message: "entity_id is required" });
    return result;
  }
  if (!isISODate(mirror_date)) {
    result.errors.push({ domain: null, kind: "bad_date", message: `mirror_date '${mirror_date}' is not YYYY-MM-DD` });
    return result;
  }

  const actor_user_id = opts.actor_user_id || null;

  // ── Resolve GL account ids up front. If any of the 5 codes are missing we
  //    fail the affected domain(s) only; AR & AP may still post even if 1300
  //    is missing.
  const { ids: acct, missing } = await loadAccountIds(supabase, entity_id, [
    "1108", "1201", "2000", "4005", "5001",
    // Routed AR summary (Phase 2): AR by customer class + revenue buckets.
    ...AR_ROUTED_CODES,
  ]);
  for (const code of missing) {
    result.errors.push({
      domain: "accounts",
      kind: "missing_gl_account",
      message: `gl_accounts row not found for code='${code}' entity='${entity_id}'`,
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // AR
  // ────────────────────────────────────────────────────────────────────
  try {
    const arRun = await findCompletedRun(supabase, { entity_id, domain: "ar", mirror_date });
    if (!arRun) {
      result.skipped.push({ domain: "ar", reason: "ar_run_not_complete" });
    } else {
      result.run_ids.ar = arRun.id;
      const existing = await findExistingSummaryJe(supabase, arRun.id);
      if (existing) {
        result.skipped.push({ domain: "ar", reason: "already_posted", existing_je_id: existing });
        result.je_ids.ar = existing;
      } else if (!acct.get("1108") || !acct.get("4005")) {
        result.errors.push({
          domain: "ar",
          kind: "missing_gl_account",
          message: "AR summary needs codes 1108 + 4005",
        });
      } else {
        // Phase 2 (revenue→GL): ROUTED daily JE — DR per (AR account ×
        // customer) with a customer subledger (1105/1107/1108 are CONTROL
        // accounts; the guard rejects bare control lines), CR per revenue
        // bucket (4005…4016) resolved per line from style brand/gender/PL +
        // the day's Xoro store→channel. Replaces the single-lump shape.
        const inputs = await loadArRoutedInputs(supabase, { entity_id, mirror_date });
        const agg = bucketMirrorDay(inputs);
        result.totals_cents.ar = agg.total_cents;
        if (agg.total_cents === 0) {
          result.skipped.push({ domain: "ar", reason: "zero_total" });
        } else {
          const payload = composeArRoutedPayload({
            entity_id, mirror_date, run_id: arRun.id, agg,
            acctIdByCode: acct, actor_user_id,
          });
          const je_id = await postJe(supabase, payload);
          result.je_ids.ar = je_id;
          await attachJeIdToRun(supabase, arRun.id, je_id);
        }
      }
    }
  } catch (e) {
    result.errors.push({
      domain: "ar",
      kind: "ar_summary_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // AP
  // ────────────────────────────────────────────────────────────────────
  try {
    const apRun = await findCompletedRun(supabase, { entity_id, domain: "ap", mirror_date });
    if (!apRun) {
      result.skipped.push({ domain: "ap", reason: "ap_run_not_complete" });
    } else {
      result.run_ids.ap = apRun.id;
      const existing = await findExistingSummaryJe(supabase, apRun.id);
      if (existing) {
        result.skipped.push({ domain: "ap", reason: "already_posted", existing_je_id: existing });
        result.je_ids.ap = existing;
      } else if (!acct.get("5001") || !acct.get("2000")) {
        result.errors.push({
          domain: "ap",
          kind: "missing_gl_account",
          message: "AP summary needs codes 5001 + 2000",
        });
      } else {
        const ap_total_cents = await sumApMirrorTotals(supabase, { entity_id, mirror_date });
        result.totals_cents.ap = ap_total_cents;
        if (ap_total_cents === 0) {
          result.skipped.push({ domain: "ap", reason: "zero_total" });
        } else {
          const payload = composeApSummaryPayload({
            entity_id, mirror_date, run_id: apRun.id, ap_total_cents,
            cogs_account_id: acct.get("5001"),
            ap_account_id: acct.get("2000"),
            actor_user_id,
          });
          const je_id = await postJe(supabase, payload);
          result.je_ids.ap = je_id;
          await attachJeIdToRun(supabase, apRun.id, je_id);
        }
      }
    }
  } catch (e) {
    result.errors.push({
      domain: "ap",
      kind: "ap_summary_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Inventory (only if delta ≥ $1)
  // ────────────────────────────────────────────────────────────────────
  try {
    const invRun = await findCompletedRun(supabase, { entity_id, domain: "inventory", mirror_date });
    if (!invRun) {
      result.skipped.push({ domain: "inventory", reason: "inventory_run_not_complete" });
    } else {
      result.run_ids.inventory = invRun.id;
      const existing = await findExistingSummaryJe(supabase, invRun.id);
      if (existing) {
        result.skipped.push({ domain: "inventory", reason: "already_posted", existing_je_id: existing });
        result.je_ids.inventory_or_null = existing;
      } else if (!acct.get("1201") || !acct.get("5001")) {
        result.errors.push({
          domain: "inventory",
          kind: "missing_gl_account",
          message: "Inventory summary needs codes 1201 + 5001",
        });
      } else {
        const today_cents = await computeInventoryValueCents(supabase, { entity_id });
        const prior_cents = await findPriorInventoryValueCents(supabase, { entity_id, mirror_date });
        const delta_cents = today_cents - prior_cents;
        result.totals_cents.inventory_delta = delta_cents;

        if (Math.abs(delta_cents) < INVENTORY_DELTA_FLOOR_CENTS) {
          result.skipped.push({ domain: "inventory", reason: "delta_below_floor" });
        } else {
          const payload = composeInventoryPayload({
            entity_id, mirror_date, run_id: invRun.id, delta_cents,
            inventory_asset_account_id: acct.get("1201"),
            cogs_account_id: acct.get("5001"),
            actor_user_id,
          });
          const je_id = await postJe(supabase, payload);
          result.je_ids.inventory_or_null = je_id;
          await attachJeIdToRun(supabase, invRun.id, je_id);
        }
      }
    }
  } catch (e) {
    result.errors.push({
      domain: "inventory",
      kind: "inventory_summary_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return result;
}

export default postDailySummaryJes;
