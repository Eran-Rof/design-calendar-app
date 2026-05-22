// api/_lib/accounting/posting/rules/manualEntry.js
//
// Accountant-authored journal entry. No transformation — the event already
// carries the fully-specified candidate. The accountant chooses the basis:
// 'ACCRUAL' (default), 'CASH' (cash-only adjustment), or 'BOTH' (a single
// adjustment that should hit both books with identical lines).

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     basis: 'ACCRUAL' | 'CASH' | 'BOTH',
 *     posting_date: 'YYYY-MM-DD',
 *     description: string,
 *     lines: JournalLine[],
 *     journal_type?: 'manual' | 'adjustment'   // default 'manual'
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function manualEntry(event) {
  const d = event.data;
  if (!d) throw new Error("manualEntry: event.data is required");
  if (!d.basis) throw new Error("manualEntry: data.basis is required (ACCRUAL | CASH | BOTH)");
  if (!d.posting_date) throw new Error("manualEntry: data.posting_date is required");
  if (!Array.isArray(d.lines) || d.lines.length === 0) {
    throw new Error("manualEntry: data.lines must be a non-empty array");
  }

  const journalType = d.journal_type ?? "manual";
  const baseCandidate = {
    entity_id: event.entity_id,
    posting_date: d.posting_date,
    journal_type: journalType,
    source_module: "manual",
    source_table: null,
    source_id: null,
    description: d.description ?? "Manual journal entry",
    created_by_user_id: event.created_by_user_id ?? null,
    lines: d.lines,
  };

  const wantAccrual = d.basis === "ACCRUAL" || d.basis === "BOTH";
  const wantCash    = d.basis === "CASH"    || d.basis === "BOTH";

  return {
    accrual: wantAccrual ? { ...baseCandidate, basis: "ACCRUAL" } : null,
    cash:    wantCash    ? { ...baseCandidate, basis: "CASH"    } : null,
  };
}
