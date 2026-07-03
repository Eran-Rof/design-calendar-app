// api/_lib/accounting/posting/index.js
//
// Public entrypoint for the posting service. Callers from API handlers do:
//
//   import { postEvent } from "./_lib/accounting/posting/index.js";
//   const result = await postEvent(supabase, {
//     kind: "ap_invoice_received",
//     entity_id: "...",
//     created_by_user_id: "...",
//     data: { ... }
//   });
//
// Internal flow:
//   1. Pick the right rule by event.kind → produce { accrual, cash } candidates.
//   2. Run each non-null candidate through the in-JS guards (fast-fail).
//   3. Persist via the gl_post_journal_entry RPC (transactional).
//   4. Link sibling JEs if both bases produced output.
//
// Per arch §4.3: the RPC + trigger combo are the source of truth; the in-JS
// guards just save round-trips on obviously-bad payloads.

import { manualEntry } from "./rules/manualEntry.js";
import { apInvoiceReceived } from "./rules/apInvoiceReceived.js";
import { apInvoicePaid } from "./rules/apInvoicePaid.js";
import { apInvoiceVoided } from "./rules/apInvoiceVoided.js";
import { arInvoiceSent } from "./rules/arInvoiceSent.js";
import { arPaymentReceived } from "./rules/arPaymentReceived.js";
import { inventoryReceipt } from "./rules/inventoryReceipt.js";
import { inventoryAdjustment } from "./rules/inventoryAdjustment.js";
import { apInvoiceGrirMatch } from "./rules/apInvoiceGrirMatch.js";
import { landedCostRevaluation } from "./rules/landedCostRevaluation.js";
import { qcVendorCredit } from "./rules/qcVendorCredit.js";
import { partAdjustment } from "./rules/partAdjustment.js";
import { mfgBuildIssue } from "./rules/mfgBuildIssue.js";
import { mfgServiceCapitalized } from "./rules/mfgServiceCapitalized.js";
import { mfgBuildComplete } from "./rules/mfgBuildComplete.js";

import { checkBalanced } from "./guards/balanced.js";
import { checkPeriodOpen } from "./guards/periodOpen.js";
import { checkControlAccountSubledger } from "./guards/controlAccountSubledger.js";
import { checkAccountPostable } from "./guards/accountPostable.js";
import { checkAccountExistsInEntity } from "./guards/accountExistsInEntity.js";

import { persistRuleOutput } from "./persist.js";
import { reverseJournalEntry } from "./reverse.js";
import {
  createLayer as createInventoryLayer,
  consume as consumeInventory,
} from "../../inventory/fifo.js";
import {
  createPartLayer,
  consumePart,
} from "../../inventory/partFifo.js";

export { reverseJournalEntry } from "./reverse.js";

const RULE_BY_KIND = {
  manual:                manualEntry,
  ap_invoice_received:   apInvoiceReceived,
  ap_invoice_paid:       apInvoicePaid,
  ap_invoice_voided:     apInvoiceVoided,
  ar_invoice_sent:       arInvoiceSent,
  ar_payment_received:   arPaymentReceived,
  inventory_receipt:     inventoryReceipt,
  inventory_adjustment:  inventoryAdjustment,
  ap_invoice_grir_match: apInvoiceGrirMatch,
  landed_cost_revaluation: landedCostRevaluation,
  qc_vendor_credit:      qcVendorCredit,
  // Manufacturing — parts have their OWN FIFO pool (partConsumePlan /
  // partInventoryLayers drains below), separate from style inventory.
  part_adjustment:       partAdjustment,
  // Manufacturing build orders (M4): issue components → WIP, capitalize a
  // conversion service → WIP, complete a build (WIP → finished goods).
  mfg_build_issue:       mfgBuildIssue,
  mfg_service_capitalized: mfgServiceCapitalized,
  mfg_build_complete:    mfgBuildComplete,
};

export class PostingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {Object} supabase   Supabase service-role client.
 * @param {import('./types.js').PostingEvent} event
 * @returns {Promise<import('./types.js').PostingResult>}
 */
export async function postEvent(supabase, event) {
  if (!event || typeof event !== "object") {
    throw new PostingError("invalid_event", "event must be an object");
  }
  if (!event.kind) {
    throw new PostingError("missing_kind", "event.kind is required");
  }
  if (!event.entity_id) {
    throw new PostingError("missing_entity_id", "event.entity_id is required");
  }

  const rule = RULE_BY_KIND[event.kind];
  if (!rule) {
    throw new PostingError("unknown_kind", `Unknown posting event kind: ${event.kind}`);
  }

  // 1. Rule → { accrual, cash } candidates  (or { reversals: [je_id, ...] } for voids)
  const ruleOutput = rule(event);

  // T11 D3: posting a JE fires the audit trigger's POST branch, which REQUIRES
  // a reason (app.audit_reason session var). Callers pass event.reason; we stamp
  // it onto each candidate so candidateToPayload → gl_post_journal_entry can
  // set_config('app.audit_reason', ...) in the SAME statement/connection that
  // flips the JE to 'posted' (the only place the var survives the pool caveat).
  // Reversals set their own reason via reverse.js and are exempt here.
  const auditReason = event.reason ? String(event.reason).trim() : "";
  if (auditReason) {
    if (ruleOutput.accrual) ruleOutput.accrual.audit_reason = auditReason;
    if (ruleOutput.cash) ruleOutput.cash.audit_reason = auditReason;
  }

  // Reversal-shape output: { accrual:null, cash:null, reversals:[...] }
  // No new candidates to balance-check — short-circuit through reverseJournalEntry.
  if (Array.isArray(ruleOutput.reversals)) {
    const reversedJeIds = [];
    for (const jeId of ruleOutput.reversals) {
      const newId = await reverseJournalEntry(supabase, jeId, {
        created_by_user_id: event.created_by_user_id ?? null,
      });
      reversedJeIds.push(newId);
    }
    return {
      accrual_je_id: null,
      cash_je_id: null,
      reversed_je_ids: reversedJeIds,
    };
  }

  if (!ruleOutput.accrual && !ruleOutput.cash) {
    throw new PostingError(
      "rule_produced_nothing",
      `Rule for ${event.kind} produced no candidate journal entries`,
    );
  }

  // 2a. consumePlan drain — two modes:
  //
  //   LEGACY 2-LINE MODE (P3-5 — M37 negative inventory adjustments):
  //     The rule emits a consumePlan whose entries have NO line-index hints.
  //     The candidate has exactly two lines (DR counter / CR inventory). We
  //     sum cogs_cents across all plan entries and rewrite line[0].debit +
  //     line[1].credit. This is the inventoryAdjustment shape.
  //
  //   INDEXED MODE (P4-3 — arInvoiceSent + future multi-line consumers):
  //     Each plan entry carries `dr_line_ix` + `cr_line_ix` pointing at the
  //     sentinel COGS pair in the candidate's line array. The rule may also
  //     emit non-COGS lines (e.g. DR AR / CR revenue) that we must NOT touch.
  //     We rewrite per-entry (each entry's cogs_cents goes to its OWN pair),
  //     and a 0-cogs entry causes its sentinel pair to be DROPPED cleanly
  //     (so we never persist a {debit:0, credit:0} no-op pair). Lines are
  //     renumbered (line_number = i+1) after any drops.
  //
  //   Both modes share the same consume() per-entry call and the same
  //   side-effect semantics: consume() mutates inventory_layers +
  //   inserts inventory_consumption BEFORE the JE persists. If JE persist
  //   fails downstream, the FIFO ledger leads the GL by one event. This
  //   asymmetry is accepted (see P3-5 docs); P4 inherits it for AR.
  //
  //   consumer_kind whitelist: `ar_invoice`, `adjustment_decrease`,
  //   `transfer_out`, `write_off`. Enforced in fifo.js consume() AND in the
  //   SQL CHECK constraint on inventory_consumption.consumer_kind (P3-3
  //   migration). No widening needed here — the drain is consumer-kind
  //   agnostic; it relays whatever the rule emitted.
  let consumePlanResults = [];
  if (Array.isArray(ruleOutput.consumePlan) && ruleOutput.consumePlan.length > 0) {
    // Detect mode: if ANY plan entry carries dr_line_ix/cr_line_ix, treat
    // the whole plan as indexed-mode (mixed plans are not supported — a
    // single rule output must commit to one mode).
    const isIndexed = ruleOutput.consumePlan.some(
      (p) => p.dr_line_ix != null || p.cr_line_ix != null,
    );

    // Execute consume() for each plan entry, in declared order.
    const perEntryCogs = []; // bigint per plan-entry
    let totalCogs = 0n;
    for (const plan of ruleOutput.consumePlan) {
      const { cogs_cents } = await consumeInventory(supabase, {
        entity_id: event.entity_id,
        item_id: plan.item_id,
        qty: plan.qty,
        consumer_kind: plan.consumer_kind,
        consumer_ref_id: plan.consumer_ref_id,
        partition_id: plan.partition_id || null, // P15 — draw from the sale's brand pool (gated)
        user_id: event.created_by_user_id || null,
      });
      perEntryCogs.push(cogs_cents);
      consumePlanResults.push({
        item_id: plan.item_id,
        qty: plan.qty,
        cogs_cents,
        // P4-3: expose target_line_id when the rule supplied it. The handler
        // uses this to write cogs_cents back onto ar_invoice_lines.cogs_cents
        // after postEvent returns.
        target_line_id: plan.target_line_id || null,
      });
      totalCogs += cogs_cents;
    }

    if (isIndexed) {
      // INDEXED MODE — per-entry rewrite + drop zero-cogs sentinel pairs.
      for (const side of ["accrual", "cash"]) {
        const cand = ruleOutput[side];
        if (!cand || !Array.isArray(cand.lines)) continue;
        const linesToDrop = new Set();
        ruleOutput.consumePlan.forEach((plan, i) => {
          const cogs = perEntryCogs[i];
          if (plan.dr_line_ix == null || plan.cr_line_ix == null) {
            throw new PostingError(
              "consume_plan_shape",
              `indexed consumePlan entry ${i} missing dr_line_ix/cr_line_ix`,
            );
          }
          if (plan.dr_line_ix >= cand.lines.length || plan.cr_line_ix >= cand.lines.length) {
            throw new PostingError(
              "consume_plan_shape",
              `indexed consumePlan entry ${i} line index out of range (${plan.dr_line_ix}/${plan.cr_line_ix}; lines=${cand.lines.length})`,
            );
          }
          if (cogs === 0n) {
            // Drop the sentinel pair — no real COGS to record.
            linesToDrop.add(plan.dr_line_ix);
            linesToDrop.add(plan.cr_line_ix);
            return;
          }
          const amountStr = bigintCentsToDecimal(cogs);
          cand.lines[plan.dr_line_ix].debit = amountStr;
          cand.lines[plan.cr_line_ix].credit = amountStr;
        });
        if (linesToDrop.size > 0) {
          cand.lines = cand.lines.filter((_, ix) => !linesToDrop.has(ix));
          // Renumber 1..N after drops so persistRuleOutput sees contiguous
          // line_numbers (the RPC tolerates gaps but downstream JE viewers
          // assume 1..N).
          cand.lines.forEach((l, i) => { l.line_number = i + 1; });
        }
      }
    } else {
      // LEGACY 2-LINE MODE — sum cogs across plan, rewrite line[0]/line[1].
      const amountStr = bigintCentsToDecimal(totalCogs);
      for (const side of ["accrual", "cash"]) {
        const cand = ruleOutput[side];
        if (!cand) continue;
        if (!Array.isArray(cand.lines) || cand.lines.length < 2) {
          throw new PostingError(
            "consume_plan_shape",
            `consumePlan path expects 2-line ${side} candidate (got ${cand.lines?.length ?? 0})`,
          );
        }
        // line 1 is DR counter; line 2 is CR inventory. Rewrite both.
        cand.lines[0].debit = amountStr;
        cand.lines[1].credit = amountStr;
      }
    }
  }

  // 2a-bis. partConsumePlan drain — the parts analogue of the consumePlan drain
  //   above, but routed through part_fifo_consume (part_inventory_layers) so
  //   parts are drawn from their OWN FIFO pool. Same two modes:
  //     LEGACY 2-LINE  — part_adjustment negative (DR counter / CR 1360 parts).
  //     INDEXED        — future mfg_build_issue (M4): one CR-parts line per part
  //                      consumed into WIP, each entry carrying dr_line_ix/cr_line_ix.
  //   consumer_kind whitelist: build_issue | adjustment_decrease | transfer_out |
  //   write_off (enforced in partFifo.js + the SQL CHECK).
  let partConsumeResults = [];
  if (Array.isArray(ruleOutput.partConsumePlan) && ruleOutput.partConsumePlan.length > 0) {
    const isIndexed = ruleOutput.partConsumePlan.some(
      (p) => p.dr_line_ix != null || p.cr_line_ix != null,
    );
    const perEntryCogs = [];
    let totalCogs = 0n;
    for (const plan of ruleOutput.partConsumePlan) {
      const { cogs_cents } = await consumePart(supabase, {
        entity_id: event.entity_id,
        part_id: plan.part_id,
        qty: plan.qty,
        consumer_kind: plan.consumer_kind,
        consumer_ref_id: plan.consumer_ref_id,
        location_id: plan.location_id || null,
        user_id: event.created_by_user_id || null,
      });
      perEntryCogs.push(cogs_cents);
      partConsumeResults.push({ part_id: plan.part_id, qty: plan.qty, cogs_cents });
      totalCogs += cogs_cents;
    }

    if (isIndexed) {
      for (const side of ["accrual", "cash"]) {
        const cand = ruleOutput[side];
        if (!cand || !Array.isArray(cand.lines)) continue;
        const linesToDrop = new Set();
        ruleOutput.partConsumePlan.forEach((plan, i) => {
          const cogs = perEntryCogs[i];
          if (plan.dr_line_ix == null || plan.cr_line_ix == null) {
            throw new PostingError("part_consume_plan_shape", `indexed partConsumePlan entry ${i} missing dr_line_ix/cr_line_ix`);
          }
          if (plan.dr_line_ix >= cand.lines.length || plan.cr_line_ix >= cand.lines.length) {
            throw new PostingError("part_consume_plan_shape", `indexed partConsumePlan entry ${i} line index out of range`);
          }
          if (cogs === 0n) { linesToDrop.add(plan.dr_line_ix); linesToDrop.add(plan.cr_line_ix); return; }
          const amountStr = bigintCentsToDecimal(cogs);
          cand.lines[plan.dr_line_ix].debit = amountStr;
          cand.lines[plan.cr_line_ix].credit = amountStr;
        });
        if (linesToDrop.size > 0) {
          cand.lines = cand.lines.filter((_, ix) => !linesToDrop.has(ix));
          cand.lines.forEach((l, i) => { l.line_number = i + 1; });
        }
      }
    } else {
      const amountStr = bigintCentsToDecimal(totalCogs);
      for (const side of ["accrual", "cash"]) {
        const cand = ruleOutput[side];
        if (!cand) continue;
        if (!Array.isArray(cand.lines) || cand.lines.length < 2) {
          throw new PostingError("part_consume_plan_shape", `partConsumePlan path expects 2-line ${side} candidate (got ${cand.lines?.length ?? 0})`);
        }
        cand.lines[0].debit = amountStr;
        cand.lines[1].credit = amountStr;
      }
    }
  }

  // 2b. Run guards on each non-null candidate
  const ctx = { supabase, entity_id: event.entity_id };

  for (const side of ["accrual", "cash"]) {
    const candidate = ruleOutput[side];
    if (!candidate) continue;
    await runGuards(candidate, ctx, side);
  }

  // 3. Persist transactionally
  const result = await persistRuleOutput(supabase, ruleOutput);

  // 3a. Expose consume results on the result (M37 audit trail + P4-3 AR
  //     write-back). target_line_id is null on legacy 2-line mode (M37) and
  //     set on indexed mode (AR send time — handler writes cogs_cents back
  //     onto ar_invoice_lines.cogs_cents after postEvent returns).
  if (consumePlanResults.length > 0) {
    result.consume_results = consumePlanResults.map((c) => ({
      item_id: c.item_id,
      qty: c.qty,
      cogs_cents: c.cogs_cents.toString(), // serialize bigint as string
      target_line_id: c.target_line_id ?? null,
    }));
  }

  // 4. P3-4 (arch §4.5): after the JE persists, create one inventory_layers
  //    row per pending layer. This fires AFTER the JE so a failed JE does NOT
  //    leave orphan layers. The reverse risk — JE posts but layer-create fails
  //    — is logged + surfaced on the result (`inventory_layer_errors`); the
  //    operator can backfill manually. We deliberately do NOT roll back the JE
  //    on layer failure because the GL truth (DR inventory / CR AP) is already
  //    correct; the FIFO ledger is a downstream audit trail that can be
  //    reconciled out-of-band.
  if (Array.isArray(ruleOutput.inventoryLayers) && ruleOutput.inventoryLayers.length > 0) {
    const layerIds = [];
    const layerErrors = [];
    for (const pending of ruleOutput.inventoryLayers) {
      // P3-5: source_kind defaults to 'ap_invoice' for back-compat with P3-4
      // (apInvoiceReceived). Positive inventoryAdjustment supplies
      // source_kind='adjustment' + source_adjustment_id.
      const sourceKind = pending.source_kind || "ap_invoice";
      try {
        const { layer } = await createInventoryLayer(supabase, {
          entity_id: event.entity_id,
          item_id: pending.item_id,
          qty: pending.qty,
          unit_cost_cents: pending.unit_cost_cents,
          source_kind: sourceKind,
          source_invoice_id: pending.source_invoice_id || null,
          source_adjustment_id: pending.source_adjustment_id || null,
          partition_id: pending.partition_id || null, // P15 brand stock pool
          received_at: pending.received_at || null,
          notes: pending.notes || null,
          created_by_user_id: event.created_by_user_id ?? null,
        });
        layerIds.push(layer?.id);
      } catch (err) {
        const message = err?.message || String(err);
        // eslint-disable-next-line no-console
        console.error(
          `[posting] ${event.kind}: FIFO layer create failed for item ${pending.item_id}: ${message}`,
        );
        layerErrors.push({ item_id: pending.item_id, error: message });
      }
    }
    result.inventory_layer_ids = layerIds;
    if (layerErrors.length > 0) {
      result.inventory_layer_errors = layerErrors;
    }
  }

  // 3b. Expose part consume results (manufacturing audit trail).
  if (partConsumeResults.length > 0) {
    result.part_consume_results = partConsumeResults.map((c) => ({
      part_id: c.part_id,
      qty: c.qty,
      cogs_cents: c.cogs_cents.toString(),
    }));
  }

  // 4b. partInventoryLayers drain — the parts analogue of step 4. Fires AFTER
  //     the JE persists; failures are logged + surfaced on
  //     result.part_inventory_layer_errors (GL truth already correct).
  if (Array.isArray(ruleOutput.partInventoryLayers) && ruleOutput.partInventoryLayers.length > 0) {
    const partLayerIds = [];
    const partLayerErrors = [];
    for (const pending of ruleOutput.partInventoryLayers) {
      const sourceKind = pending.source_kind || "ap_invoice";
      try {
        const { layer } = await createPartLayer(supabase, {
          entity_id: event.entity_id,
          part_id: pending.part_id,
          qty: pending.qty,
          unit_cost_cents: pending.unit_cost_cents,
          source_kind: sourceKind,
          source_invoice_id: pending.source_invoice_id || null,
          source_adjustment_id: pending.source_adjustment_id || null,
          location_id: pending.location_id || null,
          received_at: pending.received_at || null,
          notes: pending.notes || null,
          created_by_user_id: event.created_by_user_id ?? null,
        });
        partLayerIds.push(layer?.id);
      } catch (err) {
        const message = err?.message || String(err);
        // eslint-disable-next-line no-console
        console.error(
          `[posting] ${event.kind}: part FIFO layer create failed for part ${pending.part_id}: ${message}`,
        );
        partLayerErrors.push({ part_id: pending.part_id, error: message });
      }
    }
    result.part_inventory_layer_ids = partLayerIds;
    if (partLayerErrors.length > 0) {
      result.part_inventory_layer_errors = partLayerErrors;
    }
  }

  return result;
}

// cents (bigint) → decimal-string ("123.45"). Shared with rules; kept here so
// the consumePlan drain doesn't have to import from a sibling rule.
function bigintCentsToDecimal(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac.toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}

async function runGuards(candidate, ctx, side) {
  // checkBalanced is sync; everything else hits the DB.
  const sync = checkBalanced(candidate);
  if (!sync.ok) throw new PostingError(sync.code, `[${side}] ${sync.message}`, sync.details);

  const guards = [
    checkAccountPostable,        // catches not-found + not-active + not-postable
    checkAccountExistsInEntity,  // cross-entity leak
    checkControlAccountSubledger,// AR/AP/Inventory need subledger
    checkPeriodOpen,             // period status + entity hard-lock
  ];

  for (const g of guards) {
    const r = await g(candidate, ctx);
    if (!r.ok) {
      throw new PostingError(r.code, `[${side}] ${r.message}`, r.details);
    }
  }
}
