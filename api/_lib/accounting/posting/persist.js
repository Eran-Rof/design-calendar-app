// api/_lib/accounting/posting/persist.js
//
// Transactional persistence via the gl_post_journal_entry RPC. The RPC does
// the atomic JE-header + lines + status-flip inside one PG transaction. If
// the candidate fails any database-level guard (balance/period/control/...),
// the whole insert rolls back and we surface the error.

/**
 * Persist a single JournalEntryCandidate via the gl_post_journal_entry RPC.
 *
 * @param {Object} supabase        Supabase service-role client.
 * @param {import('./types.js').JournalEntryCandidate} candidate
 * @param {string|null} [siblingJeId]   When set, written into journal_entries.sibling_je_id before posting.
 * @returns {Promise<string>} the new journal_entries.id
 */
export async function persistCandidate(supabase, candidate, siblingJeId = null) {
  const payload = candidateToPayload(candidate, siblingJeId);

  const { data, error } = await supabase.rpc("gl_post_journal_entry", { payload });
  if (error) {
    // Postgres errors from the trigger arrive here. Surface the message so the
    // caller can map it to a UI / log entry.
    const e = new Error(`gl_post_journal_entry RPC failed: ${error.message}`);
    e.cause = error;
    e.code = "rpc_failed";
    throw e;
  }
  if (typeof data !== "string") {
    throw new Error(`gl_post_journal_entry returned unexpected payload: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Persist the accrual + cash twins of a dual-basis event, linking them via
 * journal_entries.sibling_je_id. Either side may be null (single-basis event).
 *
 * @param {Object} supabase
 * @param {import('./types.js').PostingRuleOutput} rule
 * @returns {Promise<import('./types.js').PostingResult>}
 */
export async function persistRuleOutput(supabase, rule) {
  let accrualId = null;
  let cashId = null;

  if (rule.accrual) {
    accrualId = await persistCandidate(supabase, rule.accrual, null);
  }
  if (rule.cash) {
    cashId = await persistCandidate(supabase, rule.cash, accrualId);
  }

  // Bi-directionally link the twins so reports can navigate either direction.
  if (accrualId && cashId) {
    const { error } = await supabase.rpc("gl_link_sibling_je", { je_a: accrualId, je_b: cashId });
    if (error) {
      const e = new Error(`gl_link_sibling_je failed: ${error.message}`);
      e.cause = error;
      e.code = "sibling_link_failed";
      throw e;
    }
  }

  return { accrual_je_id: accrualId, cash_je_id: cashId };
}

/**
 * @param {import('./types.js').JournalEntryCandidate} c
 * @param {string|null} siblingJeId
 */
export function candidateToPayload(c, siblingJeId) {
  const payload = {
    entity_id: c.entity_id,
    basis: c.basis,
    journal_type: c.journal_type,
    posting_date: c.posting_date,
    source_module: c.source_module,
    source_table: c.source_table ?? null,
    source_id: c.source_id ?? null,
    description: c.description,
    sibling_je_id: siblingJeId,
    created_by_user_id: c.created_by_user_id ?? null,
    lines: c.lines.map((l) => ({
      line_number: l.line_number,
      account_id: l.account_id,
      debit: l.debit ?? "0",
      credit: l.credit ?? "0",
      memo: l.memo ?? null,
      subledger_type: l.subledger_type ?? null,
      subledger_id: l.subledger_id ?? null,
    })),
  };
  // T11 D3: when the caller supplied a reason (via event.reason → stamped onto
  // the candidate by postEvent), forward it as audit_reason. gl_post_journal_entry
  // set_config's it onto app.audit_reason before flipping status to 'posted' so
  // the audit trigger's required-reason check on POST is satisfied. Omitted =>
  // key absent => RPC leaves the session var untouched (back-compat).
  if (c.audit_reason) {
    payload.audit_reason = String(c.audit_reason);
  }
  // P4-2: pass bypass_period_lock through to the RPC. The PG-side function
  // (extended in P4-1) gates this to journal_type IN
  // ('ar_invoice_historical','ar_receipt_historical') — operator UI cannot
  // set it via any non-backfill code path.
  if (c.bypass_period_lock === true) {
    payload.bypass_period_lock = true;
  }
  return payload;
}
