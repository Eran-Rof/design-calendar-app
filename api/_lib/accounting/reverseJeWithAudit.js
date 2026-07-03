// api/_lib/accounting/reverseJeWithAudit.js
//
// T11-safe reversal of a posted journal entry.
//
// The plain reverseJournalEntry() helper (posting/reverse.js) posts the negated
// entry via gl_post_journal_entry WITHOUT an audit_reason and flips the original
// to 'reversed' via a bare UPDATE. Since the T11 audit trigger REQUIRES a reason
// on both the POST (draft→posted of the reversal) and the REVERSE (original→
// reversed) transitions (mig 20260629900000 D3), that path fails once T11 is on
// unless a reason travels IN THE SAME statement as each write.
//
// This helper plumbs the reason through both writes the T11-2 way:
//   1. Post the negated (compensating) entry through gl_post_journal_entry WITH
//      payload.audit_reason (+ actor) so the RPC set_config's the audit vars in
//      the same statement that flips it to 'posted' (mig 20260939000000).
//   2. Flip the ORIGINAL to 'reversed' via reverse_journal_entry_with_audit,
//      which set_config's the audit vars + updates in one statement and stamps
//      reversed_by_je_id.
//   3. Link the reversal back to the original (reverses_je_id) — a plain UPDATE,
//      not a status transition, so it does not trip the T11 reason gate.
//
// Idempotent by status: only a 'posted' JE is reversed; a re-run finds it
// 'reversed' and returns null (already reversed).

import { callWithAudit } from "../audit/withAuditContext.js";

const ZERO_RE = /^0+(\.0+)?$/;
function isZero(v) { return v == null || ZERO_RE.test(typeof v === "string" ? v : String(v)); }
function dec(v) { return v == null ? "0" : (typeof v === "string" ? v : String(v)); }

/**
 * @param {object} admin       service-role supabase client
 * @param {string} jeId        journal_entries.id to reverse (must be 'posted')
 * @param {object} audit
 *   @param {string}  audit.reason                REQUIRED — T11 reason
 *   @param {object}  [audit.actor]               { auth_id, employee_id, display_name }
 *   @param {string}  [audit.source]              T10 source (default 'manual')
 *   @param {string}  [audit.correlation_id]
 *   @param {string}  [audit.created_by_user_id]
 *   @param {string}  [audit.posting_date]        YYYY-MM-DD override; default = the
 *                                                original entry's date (its period)
 * @returns {Promise<string|null>} the reversal JE id, or null if already reversed / not posted.
 */
export async function reverseJeWithAudit(admin, jeId, audit = {}) {
  if (!audit.reason || !String(audit.reason).trim()) {
    throw new Error("reverseJeWithAudit: audit.reason is required (T11)");
  }
  const reason = String(audit.reason).trim();
  const source = audit.source || "manual";

  const { data: original, error: jeErr } = await admin
    .from("journal_entries")
    .select("id, entity_id, basis, journal_type, posting_date, source_module, source_table, source_id, description, status")
    .eq("id", jeId)
    .maybeSingle();
  if (jeErr) throw new Error(`reverseJeWithAudit: load JE ${jeId} failed: ${jeErr.message}`);
  if (!original) throw new Error(`reverseJeWithAudit: JE ${jeId} not found`);
  if (original.status !== "posted") return null; // already reversed / not posted → nothing to do

  const { data: lines, error: linesErr } = await admin
    .from("journal_entry_lines")
    .select("line_number, account_id, debit, credit, memo, subledger_type, subledger_id")
    .eq("journal_entry_id", jeId)
    .order("line_number", { ascending: true });
  if (linesErr) throw new Error(`reverseJeWithAudit: load lines for JE ${jeId} failed: ${linesErr.message}`);
  if (!lines || lines.length === 0) throw new Error(`reverseJeWithAudit: JE ${jeId} has no lines`);

  // Negate: swap debit ↔ credit.
  const negated = lines.map((l) => ({
    line_number: l.line_number,
    account_id: l.account_id,
    debit: isZero(l.credit) ? "0" : dec(l.credit),
    credit: isZero(l.debit) ? "0" : dec(l.debit),
    memo: l.memo ? `Reversal: ${l.memo}` : "Reversal",
    subledger_type: l.subledger_type ?? null,
    subledger_id: l.subledger_id ?? null,
  }));

  // 1. Post the compensating entry WITH the audit reason (T11-safe POST).
  //    Date the reversal into the ORIGINAL entry's period (its posting_date) so
  //    the two net to zero IN the period they belong to, rather than dumping the
  //    reversal into today's period. Callers may override via audit.posting_date.
  //    (If the original period is hard-locked, gl_post_journal_entry rejects it —
  //    the caller surfaces that and can retry with an open date.)
  const postingDate = audit.posting_date && /^\d{4}-\d{2}-\d{2}$/.test(String(audit.posting_date))
    ? String(audit.posting_date)
    : original.posting_date;
  const payload = {
    entity_id: original.entity_id,
    basis: original.basis,
    journal_type: original.journal_type,
    posting_date: postingDate,
    source_module: original.source_module,
    source_table: original.source_table,
    source_id: original.source_id,
    description: `Reversal of ${original.description}`,
    sibling_je_id: null,
    created_by_user_id: audit.created_by_user_id ?? null,
    lines: negated,
    audit_reason: reason,
    audit_actor_auth_id: audit.actor?.auth_id ?? null,
    audit_actor_employee_id: audit.actor?.employee_id ?? null,
    audit_actor_display_name: audit.actor?.display_name ?? null,
    audit_source: source,
    audit_correlation_id: audit.correlation_id ?? null,
  };
  const { data: reversalJeId, error: postErr } = await admin.rpc("gl_post_journal_entry", { payload });
  if (postErr) throw new Error(`reverseJeWithAudit: post reversal for ${jeId} failed: ${postErr.message}`);

  // 2. Flip the original → reversed with audit context (T11-safe REVERSE).
  const { error: revErr } = await callWithAudit(admin, "reverse_journal_entry_with_audit", {
    je_id: jeId,
    reversal_je_id: reversalJeId,
    actor: audit.actor || null,
    reason,
    source,
    correlation_id: audit.correlation_id ?? null,
  });
  if (revErr) throw new Error(`reverseJeWithAudit: audit flip of ${jeId} failed: ${revErr.message}`);

  // 3. Back-link the reversal to the original (plain UPDATE — no status change).
  await admin.from("journal_entries").update({ reverses_je_id: jeId }).eq("id", reversalJeId);

  return reversalJeId;
}
