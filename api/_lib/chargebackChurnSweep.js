// api/_lib/chargebackChurnSweep.js
//
// Shared "factor churn" classification + auto-disposition pass over
// factor_chargebacks. Used by BOTH the statement importer
// (scripts/import-factor-pdfs.mjs, every batch) and the one-time backfill
// (scripts/backfills/chargeback_churn_classification.mjs).
//
// What it does, over the WHOLE table (new rows can complete a pair with old
// rows), in two idempotent steps:
//
//   1. CLASSIFY: run the pure classifyChurn() (api/_lib/chargebackMatch.js) —
//      greedy offset pairing + code-based kinds — and write is_factor_churn /
//      churn_kind / churn_pair_id where they changed. These are ANNOTATION
//      columns; the imported amount/reason/raw fields are never touched.
//
//   2. AUTO-DISPOSITION: rows that ARE churn AND disposition='open' AND have no
//      prior disposition history get disposition='valid' with the standard
//      status_history append (the exact {at,by,field,from,to,note} shape PATCH
//      /api/internal/chargebacks/:id writes), actor 'system:churn-auto'.
//      Operator-set dispositions and the #1854 pre-2026 bulk sign-off ('valid')
//      are never touched — the open-only guard handles both. Re-runs match 0.
//
// churn_pair_id is a deterministic uuid derived (sha1) from the pure pair_key
// (the two member ids, sorted) so both legs share it and re-imports keep it
// stable — never a random uuid per run.

import { createHash } from "node:crypto";
import { classifyChurn } from "./chargebackMatch.js";

const CHURN_AUTO_ACTOR = "system:churn-auto";
const CHURN_AUTO_NOTE = "Factor receivable churn (auto): not a customer deduction";

// Stable uuid (v5-shaped, deterministic) from a pair_key string.
export function pairKeyToUuid(pairKey) {
  const h = createHash("sha1").update(`chargeback-churn-pair:${pairKey}`).digest("hex");
  // Format 32 hex chars as 8-4-4-4-12; stamp version 5 + RFC-4122 variant bits.
  const b = h.slice(0, 32).split("");
  b[12] = "5";
  b[16] = ((parseInt(b[16], 16) & 0x3) | 0x8).toString(16);
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

async function pageAll(query, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return all;
}

// Does this row already carry a disposition change in its history? (Guards
// auto-disposition against ever re-touching an operator- or bulk-set row.)
export function hasDispositionHistory(row) {
  const h = Array.isArray(row.status_history) ? row.status_history : [];
  return h.some((e) => e && e.field === "disposition");
}

/**
 * PURE guard: may this row be auto-dispositioned to 'valid'? Only churn rows
 * that are still 'open' AND carry no prior disposition history. This is what
 * protects operator-set dispositions and the #1854 pre-2026 bulk sign-off
 * ('valid', not 'open') — they get FLAGS ONLY, never a disposition change.
 * @param {{is_factor_churn?:boolean|null, disposition?:string, status_history?:any}} row
 */
export function shouldAutoDisposition(row) {
  return row.is_factor_churn === true && row.disposition === "open" && !hasDispositionHistory(row);
}

/**
 * Run the classification + auto-disposition sweep.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb  service-role client
 * @param {{ actor?: string, log?: (msg:string)=>void }} [opts]
 * @returns {Promise<{ scanned:number, classified:{recourse_610:number,offset_pair:number,factor_admin_code:number,none:number},
 *                     flag_updates:number, auto_dispositioned:number, auto_dispositioned_cents:number }>}
 */
export async function sweepChargebackChurn(sb, opts = {}) {
  const log = opts.log || (() => {});
  const actor = opts.actor || CHURN_AUTO_ACTOR;

  const rows = await pageAll((from, to) => sb
    .from("factor_chargebacks")
    .select("id, item_num, amount_cents, reason, reason_code, cb_date, item_type, disposition, is_factor_churn, churn_kind, churn_pair_id, status_history")
    .order("id", { ascending: true })
    .range(from, to));

  const cls = classifyChurn(rows);
  const counts = { recourse_610: 0, offset_pair: 0, factor_admin_code: 0, none: 0 };

  // ── Step 1: write changed classification annotations ──────────────────────
  let flagUpdates = 0;
  for (const r of rows) {
    const c = cls.get(r.id) || null;
    const kind = c ? c.kind : null;
    const isChurn = kind != null;
    const pairId = c && c.kind === "offset_pair" ? pairKeyToUuid(c.pair_key) : null;
    if (kind) counts[kind] += 1; else counts.none += 1;

    const changed =
      (r.is_factor_churn ?? null) !== (isChurn ? true : false) ||
      (r.churn_kind ?? null) !== kind ||
      (r.churn_pair_id ?? null) !== pairId;
    if (!changed) continue;

    const { error } = await sb
      .from("factor_chargebacks")
      .update({ is_factor_churn: isChurn, churn_kind: kind, churn_pair_id: pairId })
      .eq("id", r.id);
    if (error) throw new Error(`churn flag update ${r.id}: ${error.message}`);
    flagUpdates += 1;
    // reflect locally so step 2 reads the fresh flag
    r.is_factor_churn = isChurn;
    r.churn_kind = kind;
  }
  log(`churn classified: ${counts.offset_pair} offset_pair, ${counts.recourse_610} recourse_610, ${counts.factor_admin_code} factor_admin_code (${flagUpdates} annotation update(s))`);

  // ── Step 2: auto-disposition open churn rows (no prior disposition history) ─
  let auto = 0;
  let autoCents = 0;
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    if (!shouldAutoDisposition(r)) continue;     // churn + open + no prior disposition history
    const history = Array.isArray(r.status_history) ? r.status_history : [];
    const entry = { at: nowIso, by: actor, field: "disposition", from: r.disposition, to: "valid", note: CHURN_AUTO_NOTE };
    const { error } = await sb
      .from("factor_chargebacks")
      .update({
        disposition: "valid",
        disposition_reason: CHURN_AUTO_NOTE,
        disposition_at: nowIso,
        updated_by: actor,
        updated_at: nowIso,
        status_history: [...history, entry],
      })
      .eq("id", r.id)
      .eq("disposition", "open"); // concurrency guard
    if (error) throw new Error(`churn auto-disposition ${r.id}: ${error.message}`);
    auto += 1;
    autoCents += Number(r.amount_cents) || 0;
  }
  log(`churn auto-dispositioned ${auto} open row(s) -> valid`);

  return { scanned: rows.length, classified: counts, flag_updates: flagUpdates, auto_dispositioned: auto, auto_dispositioned_cents: autoCents };
}
