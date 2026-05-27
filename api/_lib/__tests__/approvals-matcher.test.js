// Tests for api/_lib/approvals/matcher.js
//
// Pure JS — no DB.

import { describe, it, expect } from "vitest";
import { matchesRule, resolveSteps } from "../approvals/matcher.js";

describe("matchesRule", () => {
  const ctx = { entity_id: "e1", amount_cents: 600000, source_kind: "manual", vendor_new: false };

  it("empty spec matches everything", () => {
    expect(matchesRule({}, ctx)).toBe(true);
  });
  it("min_amount_cents below threshold → false", () => {
    expect(matchesRule({ min_amount_cents: 700000 }, ctx)).toBe(false);
  });
  it("min_amount_cents at threshold → true", () => {
    expect(matchesRule({ min_amount_cents: 600000 }, ctx)).toBe(true);
  });
  it("max_amount_cents above threshold → false", () => {
    expect(matchesRule({ max_amount_cents: 500000 }, ctx)).toBe(false);
  });
  it("min+max range hit", () => {
    expect(matchesRule({ min_amount_cents: 500000, max_amount_cents: 700000 }, ctx)).toBe(true);
  });
  it("missing amount_cents and amount-based clause → false", () => {
    expect(matchesRule({ min_amount_cents: 1 }, { entity_id: "e1" })).toBe(false);
  });
  it("source_kind exact match", () => {
    expect(matchesRule({ source_kind: "manual" }, ctx)).toBe(true);
    expect(matchesRule({ source_kind: "auto" }, ctx)).toBe(false);
  });
  it("vendor_new exact match", () => {
    expect(matchesRule({ vendor_new: false }, ctx)).toBe(true);
    expect(matchesRule({ vendor_new: true }, ctx)).toBe(false);
  });
  it("entity_id exact match", () => {
    expect(matchesRule({ entity_id: "e1" }, ctx)).toBe(true);
    expect(matchesRule({ entity_id: "e2" }, ctx)).toBe(false);
  });
  it("or — any branch true → true", () => {
    expect(matchesRule({ or: [{ min_amount_cents: 700000 }, { vendor_new: false }] }, ctx)).toBe(true);
  });
  it("or — all branches false → false", () => {
    expect(matchesRule({ or: [{ min_amount_cents: 700000 }, { vendor_new: true }] }, ctx)).toBe(false);
  });
  it("and — every branch true → true", () => {
    expect(matchesRule({ and: [{ min_amount_cents: 500000 }, { source_kind: "manual" }] }, ctx)).toBe(true);
  });
  it("and — any branch false → false", () => {
    expect(matchesRule({ and: [{ min_amount_cents: 500000 }, { source_kind: "auto" }] }, ctx)).toBe(false);
  });
  it("implicit AND at top level", () => {
    expect(matchesRule({ min_amount_cents: 500000, source_kind: "manual" }, ctx)).toBe(true);
    expect(matchesRule({ min_amount_cents: 500000, source_kind: "auto" }, ctx)).toBe(false);
  });
});

describe("resolveSteps", () => {
  const ctx = { entity_id: "e1", amount_cents: 600000 };
  const ruleA = {
    id: "rA",
    match: { min_amount_cents: 500000 },
    steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
  };
  const ruleB = {
    id: "rB",
    match: { min_amount_cents: 1000000 },
    steps: [{ step_order: 2, mode: "all", role_required: "accountant" }],
  };
  const ruleC = {
    id: "rC",
    match: { source_kind: "manual" },
    steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
  };

  it("returns empty when no rules match", () => {
    const r = resolveSteps([ruleB], ctx);
    expect(r.matched).toHaveLength(0);
    expect(r.steps).toHaveLength(0);
  });
  it("single matching rule → its steps", () => {
    const r = resolveSteps([ruleA, ruleB], ctx);
    expect(r.matched).toHaveLength(1);
    expect(r.steps).toEqual([{ step_order: 1, mode: "any", role_required: "admin" }]);
  });
  it("dedupes identical steps across rules", () => {
    const r = resolveSteps([ruleA, ruleC], { ...ctx, source_kind: "manual" });
    expect(r.matched).toHaveLength(2);
    expect(r.steps).toHaveLength(1);
  });
  it("sorts steps by step_order", () => {
    const r = resolveSteps([{
      id: "rD",
      match: {},
      steps: [
        { step_order: 3, mode: "any", role_required: "admin" },
        { step_order: 1, mode: "any", role_required: "accountant" },
      ],
    }], ctx);
    expect(r.steps.map((s) => s.step_order)).toEqual([1, 3]);
  });
  it("unions distinct steps from multiple rules", () => {
    const ruleE = {
      id: "rE",
      match: {},
      steps: [{ step_order: 2, mode: "any", role_required: "admin" }],
    };
    const r = resolveSteps([ruleA, ruleE], ctx);
    expect(r.steps).toHaveLength(2);
    expect(r.steps.map((s) => s.step_order)).toEqual([1, 2]);
  });
});
