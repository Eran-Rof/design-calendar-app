// api/_lib/accounting/posting/guards/accountExistsInEntity.js
//
// Cross-entity leak guard: every line's gl_accounts row must belong to the
// same entity_id as the candidate. Prevents accidental cross-tenant posting
// when multi-entity comes online.

/**
 * @param {import('../types.js').JournalEntryCandidate} candidate
 * @param {import('../types.js').GuardContext} ctx
 * @returns {Promise<import('../types.js').GuardResult>}
 */
export async function checkAccountExistsInEntity(candidate, ctx) {
  const accountIds = [...new Set(candidate.lines.map((l) => l.account_id))];
  if (accountIds.length === 0) return { ok: true };

  const { data, error } = await ctx.supabase
    .from("gl_accounts")
    .select("id, entity_id, code")
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
      // accountPostable also reports this; keep ordering of guard execution
      // such that accountPostable runs first, then this is defensive.
      return {
        ok: false,
        code: "account_not_found",
        message: `Line ${line.line_number} references unknown account ${line.account_id}`,
      };
    }
    if (acct.entity_id !== candidate.entity_id) {
      return {
        ok: false,
        code: "account_wrong_entity",
        message: `Line ${line.line_number} targets account ${acct.code} which belongs to a different entity`,
        details: {
          expected_entity_id: candidate.entity_id,
          account_entity_id: acct.entity_id,
        },
      };
    }
  }

  return { ok: true };
}
