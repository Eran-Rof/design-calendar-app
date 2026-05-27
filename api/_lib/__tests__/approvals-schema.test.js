// Tests for api/_lib/approvals/schema.js
//
// Pure JS — no DB.

import { describe, it, expect } from "vitest";
import { validateMatch, validateSteps, validateRule } from "../approvals/schema.js";

describe("validateMatch", () => {
  it("empty object matches all (valid)", () => {
    expect(validateMatch({}).ok).toBe(true);
  });
  it("rejects null", () => {
    expect(validateMatch(null).ok).toBe(false);
  });
  it("rejects array", () => {
    expect(validateMatch([1, 2]).ok).toBe(false);
  });
  it("rejects unknown operator", () => {
    const r = validateMatch({ widgets: 7 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/widgets/);
  });
  it("accepts min_amount_cents >= 0", () => {
    expect(validateMatch({ min_amount_cents: 0 }).ok).toBe(true);
    expect(validateMatch({ min_amount_cents: 500000 }).ok).toBe(true);
  });
  it("rejects min_amount_cents negative", () => {
    expect(validateMatch({ min_amount_cents: -1 }).ok).toBe(false);
  });
  it("rejects non-numeric min_amount_cents", () => {
    expect(validateMatch({ min_amount_cents: "10" }).ok).toBe(false);
  });
  it("accepts source_kind string", () => {
    expect(validateMatch({ source_kind: "manual" }).ok).toBe(true);
  });
  it("rejects source_kind non-string", () => {
    expect(validateMatch({ source_kind: 42 }).ok).toBe(false);
  });
  it("accepts vendor_new boolean", () => {
    expect(validateMatch({ vendor_new: true }).ok).toBe(true);
    expect(validateMatch({ vendor_new: false }).ok).toBe(true);
  });
  it("rejects vendor_new non-boolean", () => {
    expect(validateMatch({ vendor_new: "yes" }).ok).toBe(false);
  });
  it("recursively validates or branches", () => {
    expect(validateMatch({ or: [{ min_amount_cents: 100 }, { vendor_new: true }] }).ok).toBe(true);
    const r = validateMatch({ or: [{ widgets: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/or:/);
  });
  it("recursively validates and branches", () => {
    expect(validateMatch({ and: [{ min_amount_cents: 100 }, { entity_id: "abc" }] }).ok).toBe(true);
  });
});

describe("validateSteps", () => {
  it("rejects empty array", () => {
    expect(validateSteps([]).ok).toBe(false);
  });
  it("rejects non-array", () => {
    expect(validateSteps({}).ok).toBe(false);
  });
  it("accepts single valid step", () => {
    expect(validateSteps([{ step_order: 1, mode: "any", role_required: "admin" }]).ok).toBe(true);
  });
  it("rejects unknown role", () => {
    expect(validateSteps([{ step_order: 1, mode: "any", role_required: "cfo" }]).ok).toBe(false);
  });
  it("rejects invalid mode", () => {
    expect(validateSteps([{ step_order: 1, mode: "some", role_required: "admin" }]).ok).toBe(false);
  });
  it("rejects duplicate step_order", () => {
    const r = validateSteps([
      { step_order: 1, mode: "any", role_required: "admin" },
      { step_order: 1, mode: "all", role_required: "accountant" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/duplicate step_order/);
  });
  it("rejects step_order < 1", () => {
    expect(validateSteps([{ step_order: 0, mode: "any", role_required: "admin" }]).ok).toBe(false);
  });
  it("accepts ordered multi-step", () => {
    expect(validateSteps([
      { step_order: 1, mode: "any", role_required: "accountant" },
      { step_order: 2, mode: "any", role_required: "admin" },
    ]).ok).toBe(true);
  });
});

describe("validateRule", () => {
  it("accepts valid rule end-to-end", () => {
    const r = validateRule({
      match: { min_amount_cents: 500000 },
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects bad match", () => {
    expect(validateRule({ match: { widgets: 1 }, steps: [{ step_order: 1, mode: "any", role_required: "admin" }] }).ok).toBe(false);
  });
  it("rejects bad steps", () => {
    expect(validateRule({ match: {}, steps: [] }).ok).toBe(false);
  });
});
