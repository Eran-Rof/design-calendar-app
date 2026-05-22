// api/_lib/accounting/posting/guards/controlAccountSubledger.js
//
// Every line hitting a gl_accounts.is_control=true account must carry
// subledger_type + subledger_id. AR / AP / Inventory accounts are control
// accounts so that subledger reports always reconcile to the GL.

/**
 * @param {import('../types.js').JournalEntryCandidate} candidate
 * @param {import('../types.js').GuardContext} ctx
 * @returns {Promise<import('../types.js').GuardResult>}
 */
export async function checkControlAccountSubledger(candidate, ctx) {
  const accountIds = [...new Set(candidate.lines.map((l) => l.account_id))];
  if (accountIds.length === 0) return { ok: true };

  const { data, error } = await ctx.supabase
    .from("gl_accounts")
    .select("id, is_control, code, name")
    .in("id", accountIds);

  if (error) {
    return {
      ok: false,
      code: "account_lookup_failed",
      message: `Failed to look up accounts: ${error.message}`,
    };
  }

  const controlIds = new Set((data || []).filter((a) => a.is_control).map((a) => a.id));

  for (const line of candidate.lines) {
    if (!controlIds.has(line.account_id)) continue;
    if (!line.subledger_type || !line.subledger_id) {
      const acct = (data || []).find((a) => a.id === line.account_id);
      return {
        ok: false,
        code: "control_account_missing_subledger",
        message: `Line ${line.line_number} targets control account ${acct?.code ?? line.account_id} without subledger_type / subledger_id`,
        details: { line_number: line.line_number, account_id: line.account_id },
      };
    }
  }

  return { ok: true };
}
