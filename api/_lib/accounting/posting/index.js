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

import { checkBalanced } from "./guards/balanced.js";
import { checkPeriodOpen } from "./guards/periodOpen.js";
import { checkControlAccountSubledger } from "./guards/controlAccountSubledger.js";
import { checkAccountPostable } from "./guards/accountPostable.js";
import { checkAccountExistsInEntity } from "./guards/accountExistsInEntity.js";

import { persistRuleOutput } from "./persist.js";
import { reverseJournalEntry } from "./reverse.js";

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

  // 2. Run guards on each non-null candidate
  const ctx = { supabase, entity_id: event.entity_id };

  for (const side of ["accrual", "cash"]) {
    const candidate = ruleOutput[side];
    if (!candidate) continue;
    await runGuards(candidate, ctx, side);
  }

  // 3. Persist transactionally
  return persistRuleOutput(supabase, ruleOutput);
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
