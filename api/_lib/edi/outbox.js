// api/_lib/edi/outbox.js
//
// Pure (side-effect-free) state-machine helpers for the EDI 3PL transport
// outbox/inbox. Kept dependency-free so the cron logic is unit-testable
// without a DB or an SFTP endpoint (see api/_lib/__tests__/edi-outbox.test.js).
//
// Outbound lifecycle (edi_messages.status):
//   generated → queued → sent → acknowledged     (997 accepted)
//                     ↘ failed (retry w/ backoff) ↗
// Inbound lifecycle:
//   received → parsed → applied | staged | error
//
// A "failed" outbound row is retried by the cron until MAX_ATTEMPTS, gated by
// next_attempt_at (exponential backoff). After MAX_ATTEMPTS it stays "failed"
// and is surfaced in the UI for a manual retry.

export const MAX_ATTEMPTS = 5;

// Base backoff, doubled per attempt, capped. attempts is the count AFTER the
// current failure (1 = first failure).
const BASE_BACKOFF_MS = 5 * 60 * 1000;      // 5 min
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;  // 6 h

/** Exponential backoff for the Nth failed attempt (attempts >= 1). */
export function computeBackoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  const ms = BASE_BACKOFF_MS * 2 ** (n - 1);
  return Math.min(ms, MAX_BACKOFF_MS);
}

/**
 * Compute the next outbound row state after a transmit attempt.
 *
 * @param {object} args
 * @param {number} args.attempts   - attempts BEFORE this one (row's current value)
 * @param {boolean} args.transmitted - did the SFTP upload succeed?
 * @param {string} [args.detail]    - human transport detail / error
 * @param {Date}   [args.now]
 * @returns {{ status, attempts, transport_detail, last_error, next_attempt_at, ack_status }}
 */
export function nextOutboundState({ attempts, transmitted, detail = "", now = new Date() }) {
  const newAttempts = (Number(attempts) || 0) + 1;
  if (transmitted) {
    return {
      status: "sent",
      attempts: newAttempts,
      transmitted: true,
      transport_detail: detail,
      last_error: null,
      next_attempt_at: null,
      ack_status: "pending",
    };
  }
  const exhausted = newAttempts >= MAX_ATTEMPTS;
  const nextAt = exhausted ? null : new Date(now.getTime() + computeBackoffMs(newAttempts));
  return {
    status: "failed",
    attempts: newAttempts,
    transmitted: false,
    transport_detail: detail,
    last_error: detail,
    // When exhausted we clear the gate so a manual retry is picked up immediately.
    next_attempt_at: nextAt ? nextAt.toISOString() : null,
    ack_status: null,
    exhausted,
  };
}

/**
 * Is an outbound row eligible for a transmit attempt right now?
 * queued (never sent) or failed-but-under-cap, past its backoff gate.
 */
export function isSendable(row, now = new Date()) {
  if (!row || row.direction !== "outbound") return false;
  if (!["queued", "generated", "failed"].includes(row.status)) return false;
  if (row.status === "failed" && (Number(row.attempts) || 0) >= MAX_ATTEMPTS) return false;
  if (row.next_attempt_at && new Date(row.next_attempt_at).getTime() > now.getTime()) return false;
  return true;
}

/**
 * Reset a row for a manual retry from the UI: back to queued, attempts kept for
 * the audit trail, gate cleared so the next cron pass picks it up.
 */
export function requeueForRetry() {
  return {
    status: "queued",
    next_attempt_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Map an inbound apply outcome to the terminal edi_messages status.
 *   ok + mutated       → 'applied'
 *   ok + staged/review → 'staged'
 *   failure            → 'error'
 */
export function inboundApplyStatus(outcome) {
  if (!outcome || outcome.ok !== true) return "error";
  return outcome.staged ? "staged" : "applied";
}

/**
 * Dedupe identity for an inbound interchange. Two files with the same
 * (transaction_set, interchange control number) from the same partner are the
 * same message — the cron skips re-ingesting one it already has.
 */
export function inboundDedupeKey({ transactionSet, interchangeId }) {
  return `${String(transactionSet || "").trim()}::${String(interchangeId || "").trim()}`;
}

/** True when a freshly parsed inbound message duplicates an existing row. */
export function isDuplicateInbound(existingRows, { transactionSet, interchangeId }) {
  if (!interchangeId) return false; // no control number → cannot dedupe, let it through
  const key = inboundDedupeKey({ transactionSet, interchangeId });
  return (existingRows || []).some(
    (r) => inboundDedupeKey({ transactionSet: r.transaction_set, interchangeId: r.interchange_id }) === key,
  );
}

/** 9-digit X12 control number derived from a seed (default: now). */
export function nextControlNumber(seed = Date.now()) {
  return Math.floor(Number(seed)) % 1_000_000_000;
}
