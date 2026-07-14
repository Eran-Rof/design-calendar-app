// P28-2 — get_today executor for the Ask AI loop.
//
// Returns the CALLER's Today aggregate through the exact same lens as the
// Today page (shared _lib/assistant/context.js): RBAC-filtered when
// enforcement is on and the operator is identified, per-day dismissals
// applied, insights included. execCtx.user_id comes from the request body
// (the panel sends the cached auth id) — deliberately NOT a tool
// parameter, so the model can never be coerced into reading another
// operator's queue (same invariant as lookup_user_facts).

import { buildTodayForUser, aggregateForModel } from "../assistant/context.js";

export async function tool_get_today(db, _input, execCtx) {
  const authUserId = typeof execCtx?.user_id === "string" ? execCtx.user_id : null;
  const { day, payload } = await buildTodayForUser(db, { authUserId });
  const compact = aggregateForModel(payload);
  return {
    date: day,
    personal: Boolean(authUserId),
    ...compact,
    insights: (payload.insights || []).slice(0, 10).map((i) => ({
      title: i.title || null, summary: i.summary || i.recommendation || null,
    })),
  };
}
