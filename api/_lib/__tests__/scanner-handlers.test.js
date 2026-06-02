// Tests for P3-8 scanner handler validation and pure-logic functions.
//
// Covers:
//   - validateInsert (sessions/index.js)
//   - validateBatch (events/batch.js)
//   - aggregateEvents (sessions/submit.js)
//   - isUuid contract across handlers

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/scanner/sessions/index.js";
import { validateBatch } from "../../_handlers/internal/scanner/events/batch.js";
import { aggregateEvents } from "../../_handlers/internal/scanner/sessions/submit.js";
import { isUuid as isUuidSessions } from "../../_handlers/internal/scanner/sessions/index.js";
import { isUuid as isUuidEvents } from "../../_handlers/internal/scanner/events/batch.js";
import { isUuid as isUuidSubmit } from "../../_handlers/internal/scanner/sessions/submit.js";

const UUID_A = "00000000-0000-0000-0000-000000000001";
const UUID_B = "00000000-0000-0000-0000-000000000002";
const UUID_C = "00000000-0000-0000-0000-000000000003";
const UUID_D = "00000000-0000-0000-0000-000000000004";

// ─── validateInsert (sessions) ──────────────────────────────────────────────
describe("scanner sessions validateInsert", () => {
  it("rejects missing mode", () => {
    expect(validateInsert({}).error).toMatch(/mode required/);
  });
  it("rejects invalid mode", () => {
    expect(validateInsert({ mode: "scribble" }).error).toMatch(/mode must be/);
  });
  it("rejects missing target_kind", () => {
    expect(validateInsert({ mode: "receive" }).error).toMatch(/target_kind required/);
  });
  it("rejects invalid target_kind", () => {
    expect(validateInsert({ mode: "receive", target_kind: "elsewhere" }).error).toMatch(/target_kind must be/);
  });
  it("rejects missing device_user_id", () => {
    expect(validateInsert({ mode: "receive", target_kind: "po" }).error).toMatch(/device_user_id required/);
  });
  it("rejects non-uuid device_user_id", () => {
    expect(validateInsert({
      mode: "receive", target_kind: "po", device_user_id: "abc",
    }).error).toMatch(/device_user_id must be a uuid/);
  });
  it("rejects missing target_id for non-adhoc", () => {
    expect(validateInsert({
      mode: "receive", target_kind: "po", device_user_id: UUID_A,
    }).error).toMatch(/target_id required/);
  });
  it("rejects target_id when adhoc", () => {
    expect(validateInsert({
      mode: "receive", target_kind: "adhoc", target_id: UUID_B, device_user_id: UUID_A,
    }).error).toMatch(/target_id must be null when target_kind=adhoc/);
  });
  it("accepts valid receive/po combination", () => {
    const v = validateInsert({
      mode: "receive", target_kind: "po", target_id: UUID_B, device_user_id: UUID_A,
    });
    expect(v.error).toBeUndefined();
    expect(v.data.mode).toBe("receive");
    expect(v.data.target_kind).toBe("po");
    expect(v.data.target_id).toBe(UUID_B);
    expect(v.data.device_user_id).toBe(UUID_A);
    expect(v.data.status).toBe("open");
    expect(v.data.client_meta).toEqual({});
  });
  it("accepts adhoc with null target_id", () => {
    const v = validateInsert({
      mode: "transfer", target_kind: "adhoc", device_user_id: UUID_A,
    });
    expect(v.error).toBeUndefined();
    expect(v.data.target_id).toBeNull();
  });
  it("passes through valid client_meta", () => {
    const v = validateInsert({
      mode: "count", target_kind: "cycle_count", target_id: UUID_B,
      device_user_id: UUID_A, client_meta: { app_ver: "1.0.0", network: "wifi" },
    });
    expect(v.data.client_meta.app_ver).toBe("1.0.0");
  });
  it("rejects client_meta arrays", () => {
    expect(validateInsert({
      mode: "receive", target_kind: "po", target_id: UUID_B, device_user_id: UUID_A,
      client_meta: ["nope"],
    }).error).toMatch(/client_meta must be an object/);
  });
});

// ─── validateBatch (events) ─────────────────────────────────────────────────
describe("scanner events validateBatch", () => {
  it("rejects missing session_id", () => {
    expect(validateBatch({ events: [] }).error).toMatch(/session_id required/);
  });
  it("rejects non-uuid session_id", () => {
    expect(validateBatch({ session_id: "abc", events: [] }).error).toMatch(/session_id required/);
  });
  it("rejects non-array events", () => {
    expect(validateBatch({ session_id: UUID_A }).error).toMatch(/events must be an array/);
  });
  it("rejects empty events", () => {
    expect(validateBatch({ session_id: UUID_A, events: [] }).error).toMatch(/non-empty/);
  });
  it("rejects too many events", () => {
    const events = Array.from({ length: 501 }, (_, i) => ({
      client_event_id: UUID_B, scanned_barcode: `B${i}`,
      client_timestamp: "2026-05-27T10:00:00Z",
    }));
    expect(validateBatch({ session_id: UUID_A, events }).error).toMatch(/500/);
  });
  it("rejects event without client_event_id", () => {
    expect(validateBatch({
      session_id: UUID_A,
      events: [{ scanned_barcode: "X", client_timestamp: "2026-05-27T10:00:00Z" }],
    }).error).toMatch(/client_event_id required/);
  });
  it("rejects event with empty barcode", () => {
    expect(validateBatch({
      session_id: UUID_A,
      events: [{ client_event_id: UUID_B, scanned_barcode: "", client_timestamp: "2026-05-27T10:00:00Z" }],
    }).error).toMatch(/scanned_barcode required/);
  });
  it("rejects event with bad resolved_item_id", () => {
    expect(validateBatch({
      session_id: UUID_A,
      events: [{ client_event_id: UUID_B, scanned_barcode: "X", resolved_item_id: "nope", client_timestamp: "2026-05-27T10:00:00Z" }],
    }).error).toMatch(/resolved_item_id must be a uuid/);
  });
  it("rejects event with non-numeric qty", () => {
    expect(validateBatch({
      session_id: UUID_A,
      events: [{ client_event_id: UUID_B, scanned_barcode: "X", qty: "abc", client_timestamp: "2026-05-27T10:00:00Z" }],
    }).error).toMatch(/qty must be a finite number/);
  });
  it("rejects event with bad client_timestamp", () => {
    expect(validateBatch({
      session_id: UUID_A,
      events: [{ client_event_id: UUID_B, scanned_barcode: "X", client_timestamp: "not-a-date" }],
    }).error).toMatch(/client_timestamp must be a parseable timestamp/);
  });
  it("defaults qty to 1", () => {
    const v = validateBatch({
      session_id: UUID_A,
      events: [{ client_event_id: UUID_B, scanned_barcode: "X", client_timestamp: "2026-05-27T10:00:00Z" }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.events[0].qty).toBe(1);
  });
  it("accepts a clean batch with multiple events", () => {
    const v = validateBatch({
      session_id: UUID_A,
      events: [
        { client_event_id: UUID_B, scanned_barcode: "ABC", qty: 2, client_timestamp: "2026-05-27T10:00:00Z" },
        { client_event_id: UUID_C, scanned_barcode: "DEF", resolved_item_id: UUID_D, qty: 1, client_timestamp: "2026-05-27T10:00:01Z" },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.events).toHaveLength(2);
    expect(v.data.events[0].scanned_barcode).toBe("ABC");
    expect(v.data.events[1].resolved_item_id).toBe(UUID_D);
  });
  it("trims whitespace from barcode", () => {
    const v = validateBatch({
      session_id: UUID_A,
      events: [{ client_event_id: UUID_B, scanned_barcode: "  ABC  ", client_timestamp: "2026-05-27T10:00:00Z" }],
    });
    expect(v.data.events[0].scanned_barcode).toBe("ABC");
  });
});

// ─── aggregateEvents (submit logic) ─────────────────────────────────────────
describe("scanner submit aggregateEvents", () => {
  it("returns empty array for no events", () => {
    expect(aggregateEvents([])).toEqual([]);
  });
  it("sums qty per resolved_item_id", () => {
    const out = aggregateEvents([
      { resolved_item_id: UUID_A, qty: 2 },
      { resolved_item_id: UUID_A, qty: 3 },
      { resolved_item_id: UUID_B, qty: 1 },
    ]);
    const a = out.find((r) => r.resolved_item_id === UUID_A);
    const b = out.find((r) => r.resolved_item_id === UUID_B);
    expect(a.qty).toBe(5);
    expect(b.qty).toBe(1);
  });
  it("buckets unresolved events by barcode", () => {
    const out = aggregateEvents([
      { resolved_item_id: null, scanned_barcode: "BAD1", qty: 1 },
      { resolved_item_id: null, scanned_barcode: "BAD1", qty: 2 },
      { resolved_item_id: null, scanned_barcode: "BAD2", qty: 1 },
    ]);
    const unresolved = out.filter((r) => !r.resolved_item_id);
    expect(unresolved).toHaveLength(2);
    const bad1 = unresolved.find((r) => r.scanned_barcode === "BAD1");
    expect(bad1.qty).toBe(3);
  });
  it("treats string qty values as numbers", () => {
    const out = aggregateEvents([
      { resolved_item_id: UUID_A, qty: "2.5" },
      { resolved_item_id: UUID_A, qty: "0.5" },
    ]);
    expect(out[0].qty).toBe(3);
  });
  it("idempotency demo: same events twice yield same shape", () => {
    // The actual DB-level idempotency is enforced by UNIQUE(session_id, client_event_id).
    // For pure logic, calling aggregateEvents twice on the same list is deterministic.
    const events = [
      { resolved_item_id: UUID_A, qty: 1 },
      { resolved_item_id: UUID_B, qty: 1 },
    ];
    const a = aggregateEvents(events);
    const b = aggregateEvents(events);
    expect(a).toEqual(b);
  });
});

// ─── isUuid contract (must be identical across handlers) ───────────────────
describe("scanner handlers isUuid contract", () => {
  const cases = [
    [UUID_A, true],
    ["", false],
    ["abc", false],
    ["00000000-0000-0000-0000-00000000000Z", false], // non-hex
    ["00000000-0000-0000-0000-0000000000010", false], // too long
    [null, false],
    [undefined, false],
  ];
  for (const [val, expected] of cases) {
    it(`isUuid(${JSON.stringify(val)}) → ${expected} (sessions index)`, () => {
      expect(isUuidSessions(val)).toBe(expected);
    });
    it(`isUuid(${JSON.stringify(val)}) → ${expected} (events batch)`, () => {
      expect(isUuidEvents(val)).toBe(expected);
    });
    it(`isUuid(${JSON.stringify(val)}) → ${expected} (sessions submit)`, () => {
      expect(isUuidSubmit(val)).toBe(expected);
    });
  }
});
