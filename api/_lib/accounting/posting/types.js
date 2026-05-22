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
 *           'ar_receipt' | 'inventory' | 'adjustment' | 'fx' | 'close'} JournalType
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
 * @property {JournalLine[]}   lines
 *
 * @typedef {Object} PostingRuleOutput
 * @property {JournalEntryCandidate|null} accrual
 * @property {JournalEntryCandidate|null} cash
 *
 * @typedef {Object} PostingResult
 * @property {string|null} accrual_je_id   UUID of the ACCRUAL JE persisted (or null).
 * @property {string|null} cash_je_id      UUID of the CASH JE persisted (or null).
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
 * @property {Object}              data          Event-specific payload.
 */

export {}; // marker so this is treated as a module
