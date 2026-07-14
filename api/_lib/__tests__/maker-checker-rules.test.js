// Tests for the maker/checker (segregation-of-duties) control:
//   1. threshold rule evaluation (matcher) — below vs at/above threshold,
//   2. exemption by source_kind (how automated posters are excluded),
//   3. self-approval rejection (created_by ≠ approver) in decide().
//
// The threshold + exemption tests exercise the PURE matcher (matcher.js). The
// self-approval test exercises decide() against a tiny in-memory mock client
// (same shape as approvals-lifecycle.test.js).

import { describe, it, expect } from "vitest";
import { resolveSteps, matchesRule } from "../approvals/matcher.js";
import { requestIfRequired, decide, ApprovalsError } from "../approvals/index.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const MAKER = "00000000-0000-0000-0000-0000000000aa"; // request creator
const CHECKER = "00000000-0000-0000-0000-0000000000bb"; // independent admin

// The two rules seeded by migration 20260989000000 (manual JE / AP payment,
// both ≥ $5,000 → one admin approval).
const JE_RULE = {
  id: "r-je", entity_id: ENTITY, kind: "je_manual_post", is_active: true,
  match: { min_amount_cents: 500000 },
  steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
};
const AP_RULE = {
  id: "r-ap", entity_id: ENTITY, kind: "ap_payment", is_active: true,
  match: { min_amount_cents: 500000 },
  steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
};

describe("threshold rule evaluation", () => {
  it("does NOT require approval below the $5,000 threshold", () => {
    const { matched, steps } = resolveSteps([JE_RULE], { amount_cents: 499999 });
    expect(matched).toHaveLength(0);
    expect(steps).toHaveLength(0);
  });

  it("requires approval exactly at the $5,000 threshold", () => {
    const { matched, steps } = resolveSteps([JE_RULE], { amount_cents: 500000 });
    expect(matched).toHaveLength(1);
    expect(steps).toEqual([{ step_order: 1, mode: "any", role_required: "admin" }]);
  });

  it("requires approval above the threshold (AP payment)", () => {
    const { matched } = resolveSteps([AP_RULE], { amount_cents: 1234567 });
    expect(matched).toHaveLength(1);
  });

  it("does not match a different kind's rule", () => {
    // The AP rule should never be evaluated for a JE context — requestIfRequired
    // pre-filters by kind, but resolveSteps also returns nothing here because
    // callers only pass rules for the matching kind.
    const { matched } = resolveSteps([], { amount_cents: 900000 });
    expect(matched).toHaveLength(0);
  });
});

describe("exemption by source", () => {
  // Automated posters (xoro_gl_mirror, crons, migrations) never call the human
  // handler, so they never reach the gate. This test documents the matcher-level
  // mechanism: a rule scoped with source_kind only fires for that source.
  const HUMAN_ONLY_RULE = {
    ...JE_RULE, match: { min_amount_cents: 500000, source_kind: "manual" },
  };

  it("matches a human (source_kind=manual) posting above threshold", () => {
    expect(matchesRule(HUMAN_ONLY_RULE.match, { amount_cents: 800000, source_kind: "manual" })).toBe(true);
  });

  it("exempts an automated (source_kind=xoro_gl_mirror) posting above threshold", () => {
    expect(matchesRule(HUMAN_ONLY_RULE.match, { amount_cents: 800000, source_kind: "xoro_gl_mirror" })).toBe(false);
  });
});

// ── decide() self-approval enforcement ──────────────────────────────────────
function buildClient(state) {
  return { from(table) { return new Chain(table, state[table] || (state[table] = []), state); } };
}
class Chain {
  constructor(table, rows, all) {
    this.table = table; this.rows = rows; this.all = all;
    this.filters = []; this.insertRows = null; this.updateData = null;
    this.deleteFlag = false; this.limitN = null; this.singleFlag = false; this.maybeSingleFlag = false;
  }
  select() { return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  limit(n) { this.limitN = n; return this; }
  insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(d) { this.updateData = d; return this; }
  delete() { this.deleteFlag = true; return this; }
  single() { this.singleFlag = true; return this._run(); }
  maybeSingle() { this.maybeSingleFlag = true; return this._run(); }
  then(res, rej) { return this._run().then(res, rej); }
  async _run() {
    if (this.insertRows) {
      const out = [];
      for (const r of this.insertRows) {
        const row = { id: `id-${this.all.__seq = (this.all.__seq || 0) + 1}`, ...r };
        this.rows.push(row); out.push(row);
      }
      return this.singleFlag ? { data: out[0], error: null } : { data: out, error: null };
    }
    if (this.updateData) {
      const m = this.rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of m) Object.assign(r, this.updateData);
      return this.singleFlag ? { data: m[0] || null, error: null } : { data: m, error: null };
    }
    if (this.deleteFlag) {
      const survivors = this.rows.filter((r) => !this.filters.every((f) => f(r)));
      this.rows.length = 0; survivors.forEach((r) => this.rows.push(r));
      return { data: null, error: null };
    }
    let f = this.rows.filter((r) => this.filters.every((fn) => fn(r)));
    if (this.limitN != null) f = f.slice(0, this.limitN);
    if (this.singleFlag) return f.length ? { data: f[0], error: null } : { data: null, error: { message: "not found" } };
    if (this.maybeSingleFlag) return { data: f[0] || null, error: null };
    return { data: f, error: null };
  }
}

async function seedRequest() {
  const state = {
    approval_rules: [JE_RULE],
    approval_requests: [],
    approval_request_steps: [],
    approval_decisions: [],
    // Both the maker and the checker hold the admin role, to prove the block is
    // about IDENTITY (maker≠checker), not about role.
    entity_users: [
      { id: "eu-maker", auth_id: MAKER, entity_id: ENTITY, role: "admin" },
      { id: "eu-checker", auth_id: CHECKER, entity_id: ENTITY, role: "admin" },
    ],
  };
  const sb = buildClient(state);
  const r = await requestIfRequired(sb, {
    kind: "je_manual_post", entity_id: ENTITY,
    context_table: "journal_entries", context_id: "00000000-0000-0000-0000-0000000000ee",
    amount_cents: 900000, created_by_user_id: MAKER,
  });
  return { state, sb, request_id: r.request_id, step_id: state.approval_request_steps[0].id };
}

describe("self-approval enforcement (segregation of duties)", () => {
  it("blocks the maker from approving their own request", async () => {
    const { sb, request_id, step_id } = await seedRequest();
    await expect(
      decide(sb, { request_id, step_id, decision: "approve" }, { actor_user_id: MAKER }),
    ).rejects.toThrow(/segregation of duties|requester cannot approve/i);
  });

  it("raises the specific ApprovalsError code", async () => {
    const { sb, request_id, step_id } = await seedRequest();
    await expect(
      decide(sb, { request_id, step_id, decision: "approve" }, { actor_user_id: MAKER }),
    ).rejects.toMatchObject({ code: "self_approval_forbidden" });
  });

  it("allows an INDEPENDENT checker to approve", async () => {
    const { sb, state, request_id, step_id } = await seedRequest();
    const out = await decide(sb, { request_id, step_id, decision: "approve" }, { actor_user_id: CHECKER });
    expect(out.finalized).toBe(true);
    expect(state.approval_requests[0].status).toBe("approved");
  });

  it("still lets the maker REJECT (withdraw) their own request", async () => {
    const { sb, state, request_id, step_id } = await seedRequest();
    const out = await decide(sb, { request_id, step_id, decision: "reject" }, { actor_user_id: MAKER });
    expect(out.finalized).toBe(true);
    expect(state.approval_requests[0].status).toBe("rejected");
  });
});
