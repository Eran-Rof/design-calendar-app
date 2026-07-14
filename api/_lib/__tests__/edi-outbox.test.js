// Tests for the EDI outbox/inbox state machine (api/_lib/edi/outbox.js).
// All pure — no DB, no network.

import { describe, it, expect } from "vitest";
import {
  MAX_ATTEMPTS, computeBackoffMs, nextOutboundState, isSendable,
  requeueForRetry, inboundApplyStatus, inboundDedupeKey, isDuplicateInbound,
  nextControlNumber,
} from "../edi/outbox.js";

describe("computeBackoffMs — exponential + capped", () => {
  it("grows with attempt count", () => {
    expect(computeBackoffMs(1)).toBeLessThan(computeBackoffMs(2));
    expect(computeBackoffMs(2)).toBeLessThan(computeBackoffMs(3));
  });
  it("is capped at 6h", () => {
    expect(computeBackoffMs(99)).toBe(6 * 60 * 60 * 1000);
  });
  it("floors at attempts>=1", () => {
    expect(computeBackoffMs(0)).toBe(computeBackoffMs(1));
  });
});

describe("nextOutboundState — transmit outcome", () => {
  it("sent on success, ack pending, gate cleared", () => {
    const s = nextOutboundState({ attempts: 0, transmitted: true, detail: "ok" });
    expect(s.status).toBe("sent");
    expect(s.attempts).toBe(1);
    expect(s.ack_status).toBe("pending");
    expect(s.next_attempt_at).toBeNull();
    expect(s.last_error).toBeNull();
  });
  it("failed with backoff gate while under cap", () => {
    const now = new Date("2026-07-14T00:00:00Z");
    const s = nextOutboundState({ attempts: 0, transmitted: false, detail: "boom", now });
    expect(s.status).toBe("failed");
    expect(s.attempts).toBe(1);
    expect(s.last_error).toBe("boom");
    expect(s.exhausted).toBe(false);
    expect(new Date(s.next_attempt_at).getTime()).toBeGreaterThan(now.getTime());
  });
  it("exhausted at MAX_ATTEMPTS clears the gate (manual retry only)", () => {
    const s = nextOutboundState({ attempts: MAX_ATTEMPTS - 1, transmitted: false, detail: "boom" });
    expect(s.status).toBe("failed");
    expect(s.attempts).toBe(MAX_ATTEMPTS);
    expect(s.exhausted).toBe(true);
    expect(s.next_attempt_at).toBeNull();
  });
});

describe("isSendable — queue eligibility", () => {
  const now = new Date("2026-07-14T12:00:00Z");
  it("queued outbound with no gate is sendable", () => {
    expect(isSendable({ direction: "outbound", status: "queued", attempts: 0, next_attempt_at: null }, now)).toBe(true);
  });
  it("failed under cap past its gate is sendable", () => {
    expect(isSendable({ direction: "outbound", status: "failed", attempts: 2, next_attempt_at: "2026-07-14T11:00:00Z" }, now)).toBe(true);
  });
  it("failed under cap before its gate is NOT sendable", () => {
    expect(isSendable({ direction: "outbound", status: "failed", attempts: 2, next_attempt_at: "2026-07-14T13:00:00Z" }, now)).toBe(false);
  });
  it("failed at cap is NOT auto-sendable", () => {
    expect(isSendable({ direction: "outbound", status: "failed", attempts: MAX_ATTEMPTS, next_attempt_at: null }, now)).toBe(false);
  });
  it("inbound / sent / acknowledged are never sendable", () => {
    expect(isSendable({ direction: "inbound", status: "queued" }, now)).toBe(false);
    expect(isSendable({ direction: "outbound", status: "sent" }, now)).toBe(false);
    expect(isSendable({ direction: "outbound", status: "acknowledged" }, now)).toBe(false);
  });
});

describe("requeueForRetry", () => {
  it("resets to queued and clears the gate", () => {
    const r = requeueForRetry();
    expect(r.status).toBe("queued");
    expect(r.next_attempt_at).toBeNull();
    expect(r.last_error).toBeNull();
  });
});

describe("inboundApplyStatus", () => {
  it("maps outcomes to terminal statuses", () => {
    expect(inboundApplyStatus({ ok: true, staged: false })).toBe("applied");
    expect(inboundApplyStatus({ ok: true, staged: true })).toBe("staged");
    expect(inboundApplyStatus({ ok: false })).toBe("error");
    expect(inboundApplyStatus(null)).toBe("error");
  });
});

describe("inbound dedupe", () => {
  it("keys on (transaction_set, interchange control number)", () => {
    expect(inboundDedupeKey({ transactionSet: "945", interchangeId: "000000042" }))
      .toBe(inboundDedupeKey({ transactionSet: "945", interchangeId: "000000042" }));
    expect(inboundDedupeKey({ transactionSet: "945", interchangeId: "000000042" }))
      .not.toBe(inboundDedupeKey({ transactionSet: "944", interchangeId: "000000042" }));
  });
  it("detects a duplicate against existing rows", () => {
    const existing = [{ transaction_set: "945", interchange_id: "000000042" }];
    expect(isDuplicateInbound(existing, { transactionSet: "945", interchangeId: "000000042" })).toBe(true);
    expect(isDuplicateInbound(existing, { transactionSet: "945", interchangeId: "000000099" })).toBe(false);
  });
  it("never dedupes when there is no control number", () => {
    expect(isDuplicateInbound([{ transaction_set: "945", interchange_id: "" }], { transactionSet: "945", interchangeId: "" })).toBe(false);
  });
});

describe("nextControlNumber", () => {
  it("is a 9-digit-max integer", () => {
    const n = nextControlNumber(1_752_500_000_123);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(1_000_000_000);
  });
});
