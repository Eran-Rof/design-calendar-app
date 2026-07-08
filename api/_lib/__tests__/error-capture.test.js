import { describe, it, expect } from "vitest";
import { fingerprintOf } from "../errorCapture.js";

describe("errorCapture fingerprintOf — volatile tokens normalize so errors group", () => {
  it("groups messages differing only by ids/numbers", () => {
    expect(fingerprintOf("/api/internal/purchase-orders/:id", "PO 123 not found"))
      .toBe(fingerprintOf("/api/internal/purchase-orders/:id", "PO 4567 not found"));
    expect(fingerprintOf("/api/x", "row 550e8400-e29b-41d4-a716-446655440000 missing"))
      .toBe(fingerprintOf("/api/x", "row 6ba7b810-9dad-11d1-80b4-00c04fd430c8 missing"));
  });
  it("different routes or messages get different fingerprints", () => {
    expect(fingerprintOf("/api/a", "boom")).not.toBe(fingerprintOf("/api/b", "boom"));
    expect(fingerprintOf("/api/a", "boom")).not.toBe(fingerprintOf("/api/a", "bang"));
  });
  it("is stable and short", () => {
    const f = fingerprintOf("/api/a", "boom");
    expect(f).toBe(fingerprintOf("/api/a", "boom"));
    expect(f).toMatch(/^[0-9a-f]{16}$/);
  });
});
