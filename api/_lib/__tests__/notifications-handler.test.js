// Tests for P2-4 notification preference handler validation.

import { describe, it, expect } from "vitest";
import { validateUpsert } from "../../_handlers/internal/notification-preferences/index.js";

const UUID = "00000000-0000-0000-0000-000000000001";

describe("notification-preferences validateUpsert", () => {
  it("rejects missing user_id", () => {
    expect(validateUpsert({ kind: "k", channel: "in_app", enabled: true }).error).toMatch(/user_id/);
  });
  it("rejects non-uuid user_id", () => {
    expect(validateUpsert({ user_id: "abc", kind: "k", channel: "in_app", enabled: true }).error).toMatch(/user_id/);
  });
  it("rejects missing kind", () => {
    expect(validateUpsert({ user_id: UUID, channel: "in_app", enabled: true }).error).toMatch(/kind/);
  });
  it("rejects bad channel", () => {
    expect(validateUpsert({ user_id: UUID, kind: "k", channel: "sms", enabled: true }).error).toMatch(/channel/);
  });
  it("rejects non-bool enabled", () => {
    expect(validateUpsert({ user_id: UUID, kind: "k", channel: "in_app", enabled: "yes" }).error).toMatch(/enabled/);
  });
  it("accepts valid in_app on", () => {
    expect(validateUpsert({ user_id: UUID, kind: "je_posted", channel: "in_app", enabled: true }).error).toBeUndefined();
  });
  it("accepts valid email off", () => {
    const v = validateUpsert({ user_id: UUID, kind: "je_posted", channel: "email", enabled: false });
    expect(v.error).toBeUndefined();
    expect(v.data.enabled).toBe(false);
  });
  it("trims kind", () => {
    expect(validateUpsert({ user_id: UUID, kind: "  k  ", channel: "in_app", enabled: true }).data.kind).toBe("k");
  });
});
