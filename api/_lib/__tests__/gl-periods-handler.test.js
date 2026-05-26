// Tests for the Periods admin status-transition matrix.

import { describe, it, expect } from "vitest";
import { validateStatusTransition } from "../../_handlers/internal/gl-periods/[id].js";

describe("validateStatusTransition", () => {
  // Same-status is allowed (no-op for idempotency)
  it("open → open is ok (no-op)", () => {
    expect(validateStatusTransition("open", "open").ok).toBe(true);
  });
  it("soft_close → soft_close is ok (no-op)", () => {
    expect(validateStatusTransition("soft_close", "soft_close").ok).toBe(true);
  });
  it("closed → closed is ok (no-op)", () => {
    expect(validateStatusTransition("closed", "closed").ok).toBe(true);
  });

  // Forward transitions
  it("open → soft_close is allowed", () => {
    expect(validateStatusTransition("open", "soft_close").ok).toBe(true);
  });
  it("open → closed is allowed", () => {
    expect(validateStatusTransition("open", "closed").ok).toBe(true);
  });
  it("soft_close → closed is allowed", () => {
    expect(validateStatusTransition("soft_close", "closed").ok).toBe(true);
  });

  // Reopening (backward) transitions
  it("soft_close → open is allowed (reopen)", () => {
    expect(validateStatusTransition("soft_close", "open").ok).toBe(true);
  });
  it("closed → soft_close is allowed (partial reopen)", () => {
    expect(validateStatusTransition("closed", "soft_close").ok).toBe(true);
  });
  it("closed → open is allowed (full reopen)", () => {
    expect(validateStatusTransition("closed", "open").ok).toBe(true);
  });

  // Invalid input
  it("rejects unknown current status", () => {
    expect(validateStatusTransition("frozen", "open").error).toMatch(/current status/);
  });
  it("rejects unknown next status", () => {
    expect(validateStatusTransition("open", "thawed").error).toMatch(/next status/);
  });
  it("rejects empty current status", () => {
    expect(validateStatusTransition("", "open").error).toMatch(/current status/);
  });
  it("rejects empty next status", () => {
    expect(validateStatusTransition("open", "").error).toMatch(/next status/);
  });
});
