// api/_lib/accounting/posting/types.js
//
// JSDoc type definitions for the posting service. No runtime exports.
// Shared across rules/, guards/, persist.js, reverse.js, index.js.
//
// Tangerine P1 — see docs/tangerine/P1-foundation-architecture.md §4.3.

/**
 * @typedef {'ACCRUAL' | 'CASH'} AccountingBasis
 *
 * @typedef {'DEBIT' | 'CREDIT'} NormalBalance
 *
 * @typedef {'manual' | 'ap_invoice' | 'ap_payment' | 'ar_invoice' |
 *           'ar_receipt' | 'ar_credit_memo' | 'ar_invoice_historical' |
 *           'ar_receipt_historical' | 'inventory' | 'adjustment' | 'fx' |
 *           'close'} JournalType
 *
 * @typedef {Object} JournalLine
 * @property {number}    line_number
 * @property {string}    account_id        UUID of gl_accounts row.
 * @property {string}    debit             Decimal string ("0.00" when no debit).
 * @property {string}    credit            Decimal string ("0.00" when no credit).
 * @property {string|null} [memo]
 * @property {string|null} [subledger_type]   e.g. 'vendor', 'customer', 'item'
 * @property {string|null} [subledger_id]     UUID
 *
 * @typedef {Object} JournalEntryCandidate
 * @property {AccountingBasis} basis
 * @property {JournalType}     journal_type
 * @property {string}          entity_id
 * @property {string}          posting_date    ISO date 'YYYY-MM-DD'.
 * @property {string}          source_module
 * @property {string|null}     [source_table]
 * @property {string|null}     [source_id]
 * @property {string}          description
 * @property {string|null}     [created_by_user_id]
 * @property {boolean}         [bypass_period_lock]  P4-2 — only honored when journal_type is a *_historical variant
 * @property {JournalLine[]}   lines
 *
 * @typedef {Object} PendingInventoryLayer
 * @property {string}                     item_id            UUID of ip_item_master(id).
 * @property {number|string}              qty                Positive numeric — units received.
 * @property {number|string|bigint}       unit_cost_cents    Non-negative integer cents (per-unit landed cost).
 * @property {string}                     source_invoice_id  UUID of the originating AP invoice.
 * @property {string|null}                [received_at]      ISO date/datetime; defaults to now() if omitted.
 * @property {string|null}                [notes]            Per-line memo, optional.
 *
 * @typedef {Object} ConsumePlanEntry
 * @property {string}              item_id            UUID of ip_item_master(id).
 * @property {number|string}       qty                Positive — units consumed.
 * @property {string}              consumer_kind      'ar_invoice' | 'adjustment_decrease' | 'transfer_out' | 'write_off'
 * @property {string}              consumer_ref_id    UUID of the originating row (ar_invoice/adjustment id).
 * @property {string|null}         [target_line_id]   AR-only — ar_invoice_lines.id for per-line cogs back-write.
 *
 * @typedef {Object} PostingRuleOutput
 * @property {JournalEntryCandidate|null} accrual
 * @property {JournalEntryCandidate|null} cash
 * @property {string[]}                   [reversals]        Reversal JE ids (apInvoiceVoided / arInvoiceVoided shape).
 * @property {PendingInventoryLayer[]}    [inventoryLayers]  Layers to create after JE persists (P3-4 / P4-2 credit memos).
 * @property {ConsumePlanEntry[]}         [consumePlan]      FIFO consume plan drained by postEvent before persist (P3-5 / P4-2).
 *
 * @typedef {Object} PostingResult
 * @property {string|null} accrual_je_id        UUID of the ACCRUAL JE persisted (or null).
 * @property {string|null} cash_je_id           UUID of the CASH JE persisted (or null).
 * @property {string[]}    [inventory_layer_ids] UUIDs of FIFO layers created (P3-4). Empty when no inventory lines.
 * @property {Array<{item_id:string, error:string}>} [inventory_layer_errors] Layer-create failures, if any.
 *
 * @typedef {Object} GuardContext
 * @property {Object}  supabase    Supabase service-role client.
 * @property {string}  entity_id
 *
 * @typedef {Object} GuardResult
 * @property {boolean} ok
 * @property {string}  [code]      Machine-readable code: 'unbalanced' | 'period_locked' | ...
 * @property {string}  [message]
 * @property {Object}  [details]
 *
 * @typedef {Object} PostingEvent
 * @property {string}              kind          'ap_invoice_received' | ...
 * @property {string}              entity_id
 * @property {string}              [created_by_user_id]
 * @property {string}              [reason]      T11 audit reason for the POST (required by the audit trigger on VOID/POST/REVERSE). Stamped onto each candidate → gl_post_journal_entry.audit_reason.
 * @property {Object}              data          Event-specific payload.
 */

export {}; // marker so this is treated as a module
