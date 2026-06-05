// Costing line STATUS LIFECYCLE — shared server-side transition helpers (Stage A).
//
// Stored costing_lines.status lifecycle:
//   draft -> sent -> quoted -> awarded
//                            \-> lost   (sibling won)
//   draft/sent/revised -> closed (manual, handled in the lines upsert)
//
// Every transition appends a costing_line_status_history row and NEVER
// downgrades a terminal state. Terminal = awarded, lost, closed: once a line is
// in one of these we leave it untouched (a later publish/submit must not drag it
// back to sent/quoted). 'revised' is reserved for Stage B and treated like a
// pre-send state for forward transitions.
//
// Each function takes the service-role `admin` Supabase client. All writes are
// best-effort from the caller's perspective — they log + swallow rather than
// failing the RFQ flow they hang off — but they DO surface their result so the
// caller can include it in the response for debugging.

// States that must never be moved backwards by an event-driven transition.
const TERMINAL = new Set(["awarded", "lost", "closed"]);

/**
 * Append a status_history row. Best-effort (logs + swallows on error).
 */
async function recordHistory(admin, costingLineId, status, { changedBy = "system", note = null } = {}) {
  try {
    await admin.from("costing_line_status_history").insert({
      costing_line_id: costingLineId,
      status,
      changed_by: changedBy,
      note,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[costing-status] history insert failed line=${costingLineId} status=${status}: ${e && e.message ? e.message : String(e)}`);
  }
}

/**
 * Transition a set of costing lines to `nextStatus`, but only the rows whose
 * CURRENT status is in `fromStatuses`. Writes the column + a history row each.
 * No-downgrade is enforced two ways: terminal rows are excluded by definition
 * (they won't be in `fromStatuses`), and we re-read current status to gate.
 *
 * @returns {Promise<{ moved: string[], skipped: string[] }>}
 */
async function transitionLines(admin, lineIds, nextStatus, fromStatuses, opts = {}) {
  const result = { moved: [], skipped: [] };
  const ids = (lineIds || []).filter(Boolean);
  if (ids.length === 0) return result;

  // Re-read current status so we only move eligible rows (idempotent + safe).
  const { data: rows, error } = await admin
    .from("costing_lines")
    .select("id, status")
    .in("id", ids);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn(`[costing-status] status read failed for ${nextStatus}: ${error.message}`);
    return result;
  }

  const fromSet = new Set(fromStatuses);
  const eligible = (rows || [])
    .filter((r) => !TERMINAL.has(r.status) && fromSet.has(r.status))
    .map((r) => r.id);
  result.skipped = (rows || []).map((r) => r.id).filter((id) => !eligible.includes(id));
  if (eligible.length === 0) return result;

  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin
    .from("costing_lines")
    .update({ status: nextStatus, updated_at: nowIso })
    .in("id", eligible)
    .in("status", Array.from(fromSet)); // belt-and-suspenders concurrency guard
  if (updErr) {
    // eslint-disable-next-line no-console
    console.warn(`[costing-status] update to ${nextStatus} failed: ${updErr.message}`);
    return result;
  }

  for (const id of eligible) {
    await recordHistory(admin, id, nextStatus, opts);
    result.moved.push(id);
  }
  return result;
}

/**
 * Resolve the costing_line_ids linked to an RFQ (via rfq_line_items back-pointer).
 * Returns [] for legacy / non-costing RFQs (or if the column is absent).
 */
async function costingLineIdsForRfq(admin, rfqId) {
  try {
    const { data, error } = await admin
      .from("rfq_line_items")
      .select("costing_line_id")
      .eq("rfq_id", rfqId);
    if (error) return [];
    return [...new Set((data || []).map((r) => r.costing_line_id).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * publish -> mark linked lines 'sent' if currently draft or revised.
 */
async function markLinesSent(admin, rfqId, opts = {}) {
  const ids = await costingLineIdsForRfq(admin, rfqId);
  if (ids.length === 0) return { moved: [], skipped: [] };
  return transitionLines(admin, ids, "sent", ["draft", "revised"], { note: "rfq_published", ...opts });
}

/**
 * vendor quote submit -> mark linked lines 'quoted' if currently sent.
 */
async function markLinesQuoted(admin, rfqId, opts = {}) {
  const ids = await costingLineIdsForRfq(admin, rfqId);
  if (ids.length === 0) return { moved: [], skipped: [] };
  return transitionLines(admin, ids, "quoted", ["sent"], { note: "vendor_quote_submitted", ...opts });
}

/**
 * Stage B fork -> mark a single SOURCE line 'revised' (only from sent|quoted).
 * 'revised' is NOT terminal: it freezes the old row (its RFQ is now superseded)
 * while a freshly-forked Draft copy carries the work forward. Best-effort +
 * idempotent — a line already past sent/quoted (awarded/lost/closed/draft/
 * already-revised) is skipped by the from-state guard, so re-running is a no-op.
 *
 * @returns {Promise<{ moved: string[], skipped: string[] }>}
 */
async function markLineRevised(admin, lineId, opts = {}) {
  if (!lineId) return { moved: [], skipped: [] };
  return transitionLines(admin, [lineId], "revised", ["sent", "quoted"], { note: "edit_forked", ...opts });
}

/**
 * award -> mark the awarded lines 'awarded' (from any non-terminal state), then
 * mark their SIBLINGS lost: every OTHER costing line in the SAME project with
 * the SAME style_code that is not already awarded/closed.
 *
 * `awardedLines` is an array of { id, project_id, style_code }. Idempotent and
 * safe to re-run (a second award is a no-op for already-awarded lines, and
 * siblings already lost stay lost).
 *
 * @returns {Promise<{ awarded: string[], lost: string[] }>}
 */
async function markLinesAwardedAndSiblingsLost(admin, awardedLines, opts = {}) {
  const out = { awarded: [], lost: [] };
  const lines = (awardedLines || []).filter((l) => l && l.id);
  if (lines.length === 0) return out;

  // 1. Awarded: move each from any non-terminal state to awarded. (closed/lost
  //    stay put via the terminal guard; an already-awarded re-run is a no-op.)
  const awardedRes = await transitionLines(
    admin,
    lines.map((l) => l.id),
    "awarded",
    ["draft", "sent", "quoted", "revised"],
    { note: "rfq_awarded", ...opts },
  );
  out.awarded = awardedRes.moved;

  // 2. Siblings lost: same project_id + same style_code, id != awarded line,
  //    status NOT IN ('awarded','closed'). We also exclude 'lost' (already
  //    terminal) implicitly via transitionLines' terminal guard, but query-
  //    filter the bulk read to keep it tight.
  const awardedIds = new Set(lines.map((l) => l.id));
  const siblingIds = new Set();
  for (const l of lines) {
    if (!l.project_id || !l.style_code) continue;
    const { data: sibs, error } = await admin
      .from("costing_lines")
      .select("id, status")
      .eq("project_id", l.project_id)
      .eq("style_code", l.style_code)
      .not("status", "in", "(awarded,closed,lost)");
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(`[costing-status] sibling lookup failed style=${l.style_code}: ${error.message}`);
      continue;
    }
    for (const s of sibs || []) {
      if (!awardedIds.has(s.id)) siblingIds.add(s.id);
    }
  }

  if (siblingIds.size > 0) {
    const lostRes = await transitionLines(
      admin,
      Array.from(siblingIds),
      "lost",
      ["draft", "sent", "quoted", "revised"],
      { note: "sibling_awarded", ...opts },
    );
    out.lost = lostRes.moved;
  }

  return out;
}

// Terminal-for-the-VENDOR statuses. A vendor's RFQ should lock (read-only) once
// the costing lines it quotes on can no longer be won by them: awarded (to
// anyone), lost (a sibling won), or revised (the RFQ was superseded by a forked
// Draft). 'closed' is the operator's manual terminal close. These differ from
// the forward-transition TERMINAL set only in that 'revised' is included — for
// the vendor a revised line is dead even though internally it can still move.
const VENDOR_LOCK_STATUSES = new Set(["awarded", "lost", "revised", "closed"]);

/**
 * Propagate costing-line terminal state to the VENDOR-facing RFQs.
 *
 * Cardinality (verified): each RFQ is per-vendor — generate-rfqs groups the
 * selected costing lines by vendor and emits ONE rfq per vendor, with one
 * rfq_line_items row per costing line (carrying costing_line_id). So an RFQ maps
 * 1 vendor : N costing lines.
 *
 * Rule (per-RFQ, safe): for every RFQ touched by `lineIds`, look at ALL of that
 * RFQ's rfq_line_items. If EVERY one maps to a costing line in a vendor-lock
 * state (awarded/lost/revised/closed), the vendor can no longer act on anything
 * in that RFQ, so we close it (rfqs.status='closed') — which flips the vendor's
 * canEdit to false and surfaces the read-only banner. RFQs that still have at
 * least one live (non-terminal) line are LEFT OPEN so the vendor can keep
 * quoting the lines that remain in play.
 *
 * Already-awarded RFQs are left untouched (the award handler owns that status).
 * Best-effort: logs + swallows; never breaks the caller's flow.
 *
 * LIMITATION: locking is per-RFQ, not per-line-within-a-mixed-RFQ. A vendor RFQ
 * that mixes terminal + live lines stays fully editable (including the dead
 * lines) until ALL its lines are terminal. In practice generate-rfqs tends to
 * emit one line per RFQ for costing-driven flows, so mixed RFQs are rare; the
 * conservative choice avoids ever locking a vendor out of a line they still
 * legitimately need to quote.
 *
 * @returns {Promise<{ closed: string[] }>} rfq ids newly closed.
 */
async function lockSupersededVendorRfqs(admin, lineIds, opts = {}) {
  const out = { closed: [] };
  const ids = (lineIds || []).filter(Boolean);
  if (ids.length === 0) return out;
  try {
    // 1. RFQs that reference any of these costing lines.
    const { data: hitItems, error: hitErr } = await admin
      .from("rfq_line_items")
      .select("rfq_id, costing_line_id")
      .in("costing_line_id", ids);
    if (hitErr) {
      // Pre-migration DB (no costing_line_id column) → nothing to lock.
      return out;
    }
    const rfqIds = [...new Set((hitItems || []).map((r) => r.rfq_id).filter(Boolean))];
    if (rfqIds.length === 0) return out;

    // 2. Only consider RFQs that are still live (draft/published). Awarded RFQs
    //    are owned by the award handler; already-closed RFQs are done.
    const { data: rfqRows, error: rfqErr } = await admin
      .from("rfqs")
      .select("id, status")
      .in("id", rfqIds);
    if (rfqErr) return out;
    const liveRfqIds = (rfqRows || [])
      .filter((r) => r.status === "draft" || r.status === "published")
      .map((r) => r.id);
    if (liveRfqIds.length === 0) return out;

    // 3. ALL line items for those live RFQs (not just the ones we changed) so we
    //    can test whether the whole RFQ is now terminal.
    const { data: allItems, error: allErr } = await admin
      .from("rfq_line_items")
      .select("rfq_id, costing_line_id")
      .in("rfq_id", liveRfqIds);
    if (allErr) return out;

    const allCostingLineIds = [...new Set((allItems || []).map((r) => r.costing_line_id).filter(Boolean))];
    if (allCostingLineIds.length === 0) return out;

    // 4. Current status of every costing line referenced by those RFQs.
    const { data: clRows, error: clErr } = await admin
      .from("costing_lines")
      .select("id, status")
      .in("id", allCostingLineIds);
    if (clErr) return out;
    const statusByLine = Object.fromEntries((clRows || []).map((r) => [r.id, r.status]));

    // 5. Per RFQ: is EVERY mapped costing line in a vendor-lock state?
    const itemsByRfq = new Map();
    for (const it of allItems || []) {
      if (!it.rfq_id) continue;
      if (!itemsByRfq.has(it.rfq_id)) itemsByRfq.set(it.rfq_id, []);
      itemsByRfq.get(it.rfq_id).push(it.costing_line_id);
    }
    const toClose = [];
    for (const [rfqId, lineIdsForRfq] of itemsByRfq.entries()) {
      // Only the costing-line-backed items count; if an RFQ has NO costing-line
      // items at all we can't reason about it, so skip (leave open).
      const backed = lineIdsForRfq.filter(Boolean);
      if (backed.length === 0) continue;
      const allTerminal = backed.every((lid) => VENDOR_LOCK_STATUSES.has(statusByLine[lid]));
      if (allTerminal) toClose.push(rfqId);
    }
    if (toClose.length === 0) return out;

    const nowIso = new Date().toISOString();
    const { error: updErr } = await admin
      .from("rfqs")
      .update({ status: "closed", updated_at: nowIso })
      .in("id", toClose)
      .in("status", ["draft", "published"]); // concurrency guard: never reopen/clobber awarded
    if (updErr) {
      // eslint-disable-next-line no-console
      console.warn(`[costing-status] vendor-rfq close failed: ${updErr.message}`);
      return out;
    }
    out.closed = toClose;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[costing-status] lockSupersededVendorRfqs issue: ${e && e.message ? e.message : String(e)}`);
  }
  return out;
}

export {
  TERMINAL,
  VENDOR_LOCK_STATUSES,
  recordHistory,
  transitionLines,
  costingLineIdsForRfq,
  markLinesSent,
  markLinesQuoted,
  markLineRevised,
  markLinesAwardedAndSiblingsLost,
  lockSupersededVendorRfqs,
};
