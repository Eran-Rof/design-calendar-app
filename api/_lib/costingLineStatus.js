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

export {
  TERMINAL,
  recordHistory,
  transitionLines,
  costingLineIdsForRfq,
  markLinesSent,
  markLinesQuoted,
  markLinesAwardedAndSiblingsLost,
};
