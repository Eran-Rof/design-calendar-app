// api/_lib/accounting/posting/reverse.js
//
// Reverse a previously-posted journal entry. Creates a NEW journal_entry with
// negated lines (debit ↔ credit), sets the new entry's `reverses_je_id` to
// point at the original, then flips the original's status to 'reversed' and
// sets its `reversed_by_je_id`.
//
// The reversal entry posts into TODAY's period by default (unless an explicit
// posting_date is provided). Closed-period entries can still be reversed —
// the reversal lands in an open period.

/**
 * @param {Object} supabase
 * @param {string} jeId                 ID of the journal_entry to reverse.
 * @param {Object} [opts]
 * @param {string} [opts.posting_date]  ISO date; defaults to today.
 * @param {string} [opts.description]   Override description; defaults to "Reversal of <original description>".
 * @param {string} [opts.created_by_user_id]
 * @returns {Promise<string>} the new (reversal) journal_entries.id
 */
export async function reverseJournalEntry(supabase, jeId, opts = {}) {
  // 1. Fetch the original JE + lines
  const { data: original, error: jeErr } = await supabase
    .from("journal_entries")
    .select("id, entity_id, basis, journal_type, source_module, source_table, source_id, description, status, sibling_je_id")
    .eq("id", jeId)
    .maybeSingle();

  if (jeErr) throw new Error(`reverseJournalEntry: failed to load JE ${jeId}: ${jeErr.message}`);
  if (!original) throw new Error(`reverseJournalEntry: JE ${jeId} not found`);
  if (original.status !== "posted") {
    throw new Error(`reverseJournalEntry: JE ${jeId} is in status '${original.status}', not 'posted'`);
  }

  const { data: lines, error: linesErr } = await supabase
    .from("journal_entry_lines")
    .select("line_number, account_id, debit, credit, memo, subledger_type, subledger_id")
    .eq("journal_entry_id", jeId)
    .order("line_number", { ascending: true });

  if (linesErr) throw new Error(`reverseJournalEntry: failed to load lines for JE ${jeId}: ${linesErr.message}`);
  if (!lines || lines.length === 0) {
    throw new Error(`reverseJournalEntry: JE ${jeId} has no lines (cannot reverse)`);
  }

  // 2. Build negated lines (swap debit ↔ credit)
  const negatedLines = lines.map((l) => ({
    line_number: l.line_number,
    account_id: l.account_id,
    debit: stringEq0(l.credit) ? "0" : decimalString(l.credit),
    credit: stringEq0(l.debit) ? "0" : decimalString(l.debit),
    memo: l.memo ? `Reversal: ${l.memo}` : "Reversal",
    subledger_type: l.subledger_type ?? null,
    subledger_id: l.subledger_id ?? null,
  }));

  const postingDate = opts.posting_date ?? new Date().toISOString().slice(0, 10);
  const description = opts.description ?? `Reversal of ${original.description}`;

  // 3. Post the reversal via the RPC (transactional)
  const payload = {
    entity_id: original.entity_id,
    basis: original.basis,
    journal_type: original.journal_type,
    posting_date: postingDate,
    source_module: original.source_module,
    source_table: original.source_table,
    source_id: original.source_id,
    description,
    sibling_je_id: null,                   // reversal does not have its own sibling
    created_by_user_id: opts.created_by_user_id ?? null,
    lines: negatedLines,
  };

  const { data: newJeId, error: postErr } = await supabase.rpc("gl_post_journal_entry", { payload });
  if (postErr) throw new Error(`reverseJournalEntry: RPC failed: ${postErr.message}`);

  // 4. Link the two: original.reversed_by_je_id ← new, new.reverses_je_id ← original.
  //    Then flip original.status = 'reversed'.
  const { error: linkOriginalErr } = await supabase
    .from("journal_entries")
    .update({ status: "reversed", reversed_by_je_id: newJeId })
    .eq("id", jeId);
  if (linkOriginalErr) {
    throw new Error(`reverseJournalEntry: failed to flag original as reversed: ${linkOriginalErr.message}`);
  }

  const { error: linkNewErr } = await supabase
    .from("journal_entries")
    .update({ reverses_je_id: jeId })
    .eq("id", newJeId);
  if (linkNewErr) {
    throw new Error(`reverseJournalEntry: failed to link reversal back to original: ${linkNewErr.message}`);
  }

  return newJeId;
}

function decimalString(v) {
  if (v == null) return "0";
  return typeof v === "string" ? v : String(v);
}
function stringEq0(v) {
  if (v == null) return true;
  const s = typeof v === "string" ? v : String(v);
  return /^0+(\.0+)?$/.test(s);
}
