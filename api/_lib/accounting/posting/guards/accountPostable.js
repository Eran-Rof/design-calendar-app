// api/_lib/accounting/posting/guards/accountPostable.js
//
// All referenced accounts must exist, be active, and be postable
// (is_postable=true). Roll-up parents are non-postable by definition.

/**
 * @param {import('../types.js').JournalEntryCandidate} candidate
 * @param {import('../types.js').GuardContext} ctx
 * @returns {Promise<import('../types.js').GuardResult>}
 */
export async function checkAccountPostable(candidate, ctx) {
  const accountIds = [...new Set(candidate.lines.map((l) => l.account_id))];
  if (accountIds.length === 0) return { ok: true };

  const { data, error } = await ctx.supabase
    .from("gl_accounts")
    .select("id, status, is_postable, code")
    .in("id", accountIds);

  if (error) {
    return {
      ok: false,
      code: "account_lookup_failed",
      message: `Failed to look up accounts: ${error.message}`,
    };
  }

  const byId = new Map((data || []).map((a) => [a.id, a]));

  for (const line of candidate.lines) {
    const acct = byId.get(line.account_id);
    if (!acct) {
      return {
        ok: false,
        code: "account_not_found",
        message: `Line ${line.line_number} references unknown account ${line.account_id}`,
      };
    }
    if (acct.status !== "active") {
      return {
        ok: false,
        code: "account_inactive",
        message: `Line ${line.line_number} references inactive account ${acct.code}`,
      };
    }
    if (!acct.is_postable) {
      return {
        ok: false,
        code: "account_not_postable",
        message: `Line ${line.line_number} targets non-postable (roll-up) account ${acct.code}`,
      };
    }
  }

  return { ok: true };
}
