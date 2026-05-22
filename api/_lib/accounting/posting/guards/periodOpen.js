// api/_lib/accounting/posting/guards/periodOpen.js
//
// Verify the posting_date falls in an OPEN period for the entity. Database
// trigger blocks closed/soft-closed periods on commit, but this guard runs
// pre-flight so the caller doesn't see a generic trigger exception.

/**
 * @param {import('../types.js').JournalEntryCandidate} candidate
 * @param {import('../types.js').GuardContext} ctx
 * @returns {Promise<import('../types.js').GuardResult>}
 */
export async function checkPeriodOpen(candidate, ctx) {
  if (!candidate.posting_date) {
    return { ok: false, code: "missing_posting_date", message: "posting_date is required" };
  }

  const { data, error } = await ctx.supabase
    .from("gl_periods")
    .select("id, status, starts_on, ends_on")
    .eq("entity_id", candidate.entity_id)
    .lte("starts_on", candidate.posting_date)
    .gte("ends_on", candidate.posting_date)
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      code: "period_lookup_failed",
      message: `Failed to look up period: ${error.message}`,
    };
  }

  if (!data) {
    return {
      ok: false,
      code: "no_period",
      message: `No gl_periods row covers ${candidate.posting_date} for entity ${candidate.entity_id}`,
    };
  }

  if (data.status === "closed") {
    return {
      ok: false,
      code: "period_closed",
      message: `Period containing ${candidate.posting_date} is closed`,
      details: { period_id: data.id, status: data.status },
    };
  }

  // soft_close allows only adjustment / close journal types
  if (data.status === "soft_close") {
    if (!["adjustment", "close"].includes(candidate.journal_type)) {
      return {
        ok: false,
        code: "period_soft_closed",
        message: `Period is soft-closed; only adjustment/close journal types allowed (got ${candidate.journal_type})`,
        details: { period_id: data.id, status: data.status },
      };
    }
  }

  // Entity hard-lock
  const { data: entity, error: entErr } = await ctx.supabase
    .from("entities")
    .select("posting_locked_through")
    .eq("id", candidate.entity_id)
    .maybeSingle();

  if (entErr) {
    return {
      ok: false,
      code: "entity_lookup_failed",
      message: `Failed to look up entity hard-lock: ${entErr.message}`,
    };
  }

  if (entity?.posting_locked_through && candidate.posting_date <= entity.posting_locked_through) {
    return {
      ok: false,
      code: "entity_locked",
      message: `posting_date ${candidate.posting_date} is on or before entity hard-lock ${entity.posting_locked_through}`,
      details: { posting_locked_through: entity.posting_locked_through },
    };
  }

  return { ok: true };
}
