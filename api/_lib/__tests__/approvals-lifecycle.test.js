// Tests for api/_lib/approvals/index.js — request / decide / cancel lifecycle.
//
// Uses an in-memory mock supabase client that records inserts/updates and
// returns canned rule lists.

import { describe, it, expect, beforeEach } from "vitest";
import { requestIfRequired, decide, cancel, ApprovalsError } from "../approvals/index.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-0000000000aa";
const ADMIN = "00000000-0000-0000-0000-0000000000bb";
const STAFF = "00000000-0000-0000-0000-0000000000cc";
// Independent accountant (NOT the request creator) — used by the multi-step
// tests so the approver differs from the maker (segregation of duties: the
// requester can never approve their own request).
const ACCT  = "00000000-0000-0000-0000-0000000000dd";

function buildClient(state) {
  return {
    from(table) {
      const tableState = state[table] || (state[table] = []);
      return new Chain(table, tableState, state);
    },
  };
}

class Chain {
  constructor(table, rows, allTables) {
    this.table = table;
    this.rows = rows;
    this.allTables = allTables;
    this.filters = [];
    this.selectCols = null;
    this.insertRows = null;
    this.updateData = null;
    this.deleteFlag = false;
    this.limitN = null;
    this.singleFlag = false;
    this.maybeSingleFlag = false;
  }
  select(cols) { this.selectCols = cols; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  lt(col, val) { this.filters.push((r) => r[col] < val); return this; }
  is(col, val) {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }
  limit(n) { this.limitN = n; return this; }
  insert(rows) {
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(data) { this.updateData = data; return this; }
  delete() { this.deleteFlag = true; return this; }
  single() { this.singleFlag = true; return this._run(); }
  maybeSingle() { this.maybeSingleFlag = true; return this._run(); }
  then(resolve, reject) { return this._run().then(resolve, reject); }

  async _run() {
    // INSERT
    if (this.insertRows) {
      const out = [];
      for (const r of this.insertRows) {
        const row = { id: `id-${this.allTables.__seq = (this.allTables.__seq || 0) + 1}`, ...r };
        this.rows.push(row);
        out.push(row);
      }
      if (this.singleFlag) return { data: out[0], error: null };
      return { data: out, error: null };
    }
    // UPDATE
    if (this.updateData) {
      const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, this.updateData);
      if (this.singleFlag) return { data: matched[0] || null, error: null };
      return { data: matched, error: null };
    }
    // DELETE
    if (this.deleteFlag) {
      const before = this.rows.length;
      const survivors = this.rows.filter((r) => !this.filters.every((f) => f(r)));
      this.rows.length = 0;
      for (const r of survivors) this.rows.push(r);
      return { data: null, error: null };
    }
    // SELECT
    let filtered = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.limitN != null) filtered = filtered.slice(0, this.limitN);
    if (this.singleFlag) {
      if (filtered.length === 0) return { data: null, error: { message: "not found" } };
      return { data: filtered[0], error: null };
    }
    if (this.maybeSingleFlag) {
      return { data: filtered[0] || null, error: null };
    }
    return { data: filtered, error: null };
  }
}

function seed() {
  const state = {
    approval_rules: [],
    approval_requests: [],
    approval_request_steps: [],
    approval_decisions: [],
    entity_users: [
      { id: "eu-admin", auth_id: ADMIN, entity_id: ENTITY, role: "admin" },
      { id: "eu-staff", auth_id: STAFF, entity_id: ENTITY, role: "staff" },
    ],
  };
  return { state, sb: buildClient(state) };
}

describe("requestIfRequired", () => {
  it("returns required:false when no rule matches", async () => {
    const { sb } = seed();
    const r = await requestIfRequired(sb, {
      kind: "ap_invoice", entity_id: ENTITY,
      context_table: "invoices", context_id: "inv-1",
      amount_cents: 100,
    });
    expect(r.required).toBe(false);
  });

  it("creates request + steps when a rule matches", async () => {
    const { state, sb } = seed();
    state.approval_rules.push({
      id: "r1", entity_id: ENTITY, kind: "ap_invoice", is_active: true,
      match: { min_amount_cents: 500000 },
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
    });
    const r = await requestIfRequired(sb, {
      kind: "ap_invoice", entity_id: ENTITY,
      context_table: "invoices", context_id: "inv-9",
      amount_cents: 700000, created_by_user_id: ACTOR,
    });
    expect(r.required).toBe(true);
    expect(r.request_id).toBeTruthy();
    expect(state.approval_requests).toHaveLength(1);
    expect(state.approval_request_steps).toHaveLength(1);
    expect(state.approval_request_steps[0].role_required).toBe("admin");
  });

  it("rejects missing kind / entity / context", async () => {
    const { sb } = seed();
    await expect(requestIfRequired(sb, {})).rejects.toThrow(ApprovalsError);
    await expect(requestIfRequired(sb, { kind: "x" })).rejects.toThrow(/entity_id/);
    await expect(requestIfRequired(sb, { kind: "x", entity_id: ENTITY })).rejects.toThrow(/context_table/);
  });

  it("creates multiple steps when multiple rules match", async () => {
    const { state, sb } = seed();
    state.approval_rules.push(
      { id: "r1", entity_id: ENTITY, kind: "je_post", is_active: true,
        match: {}, steps: [{ step_order: 1, mode: "any", role_required: "admin" }] },
      { id: "r2", entity_id: ENTITY, kind: "je_post", is_active: true,
        match: { source_kind: "manual" }, steps: [{ step_order: 2, mode: "any", role_required: "accountant" }] },
    );
    const r = await requestIfRequired(sb, {
      kind: "je_post", entity_id: ENTITY,
      context_table: "journal_entries", context_id: "je-1",
      source_kind: "manual", amount_cents: 0,
    });
    expect(r.required).toBe(true);
    expect(state.approval_request_steps).toHaveLength(2);
  });
});

describe("decide", () => {
  async function setupSimpleRequest({ steps = [{ step_order: 1, mode: "any", role_required: "admin" }] } = {}) {
    const { state, sb } = seed();
    state.approval_rules.push({
      id: "r1", entity_id: ENTITY, kind: "ap_invoice", is_active: true,
      match: {}, steps,
    });
    const r = await requestIfRequired(sb, {
      kind: "ap_invoice", entity_id: ENTITY,
      context_table: "invoices", context_id: "inv-1",
      amount_cents: 100, created_by_user_id: ACTOR,
    });
    return { state, sb, request_id: r.request_id, step_id: state.approval_request_steps[0].id };
  }

  it("approve on single-step any-mode finalizes request", async () => {
    const { sb, state, request_id, step_id } = await setupSimpleRequest();
    const out = await decide(sb, { request_id, step_id, decision: "approve" }, { actor_user_id: ADMIN });
    expect(out.finalized).toBe(true);
    expect(state.approval_requests[0].status).toBe("approved");
    expect(state.approval_decisions).toHaveLength(1);
  });

  it("reject finalizes immediately to rejected", async () => {
    const { sb, state, request_id, step_id } = await setupSimpleRequest();
    const out = await decide(sb, { request_id, step_id, decision: "reject" }, { actor_user_id: ADMIN });
    expect(out.finalized).toBe(true);
    expect(state.approval_requests[0].status).toBe("rejected");
  });

  it("rejects actor without required role", async () => {
    const { sb, request_id, step_id } = await setupSimpleRequest();
    await expect(
      decide(sb, { request_id, step_id, decision: "approve" }, { actor_user_id: STAFF })
    ).rejects.toThrow(/role/);
  });

  it("two-step: first step closes, request stays pending", async () => {
    const { sb, state, request_id } = await setupSimpleRequest({
      steps: [
        { step_order: 1, mode: "any", role_required: "accountant" },
        { step_order: 2, mode: "any", role_required: "admin" },
      ],
    });
    // Add an INDEPENDENT accountant (not the maker ACTOR) to approve step 1.
    state.entity_users.push({ id: "eu-acct", auth_id: ACCT, entity_id: ENTITY, role: "accountant" });
    const step1Id = state.approval_request_steps.find((s) => s.step_order === 1).id;
    const out = await decide(sb, { request_id, step_id: step1Id, decision: "approve" }, { actor_user_id: ACCT });
    expect(out.finalized).toBe(false);
    expect(state.approval_requests[0].status).toBe("pending");
  });

  it("two-step: second step closes, request approved", async () => {
    const { sb, state, request_id } = await setupSimpleRequest({
      steps: [
        { step_order: 1, mode: "any", role_required: "accountant" },
        { step_order: 2, mode: "any", role_required: "admin" },
      ],
    });
    state.entity_users.push({ id: "eu-acct", auth_id: ACCT, entity_id: ENTITY, role: "accountant" });
    const step1Id = state.approval_request_steps.find((s) => s.step_order === 1).id;
    const step2Id = state.approval_request_steps.find((s) => s.step_order === 2).id;
    await decide(sb, { request_id, step_id: step1Id, decision: "approve" }, { actor_user_id: ACCT });
    const out = await decide(sb, { request_id, step_id: step2Id, decision: "approve" }, { actor_user_id: ADMIN });
    expect(out.finalized).toBe(true);
    expect(state.approval_requests[0].status).toBe("approved");
  });

  it("blocks approving step 2 before step 1 is closed", async () => {
    const { sb, state, request_id } = await setupSimpleRequest({
      steps: [
        { step_order: 1, mode: "any", role_required: "accountant" },
        { step_order: 2, mode: "any", role_required: "admin" },
      ],
    });
    state.entity_users.push({ id: "eu-acct", auth_id: ACTOR, entity_id: ENTITY, role: "accountant" });
    const step2Id = state.approval_request_steps.find((s) => s.step_order === 2).id;
    await expect(
      decide(sb, { request_id, step_id: step2Id, decision: "approve" }, { actor_user_id: ADMIN })
    ).rejects.toThrow(/previous/);
  });

  it("rejects double-fulfilling a step", async () => {
    const { sb, request_id, step_id } = await setupSimpleRequest();
    await decide(sb, { request_id, step_id, decision: "approve" }, { actor_user_id: ADMIN });
    await expect(
      decide(sb, { request_id, step_id, decision: "approve" }, { actor_user_id: ADMIN })
    ).rejects.toThrow(/pending|fulfilled/);
  });

  it("request_changes records decision but does not finalize", async () => {
    const { sb, state, request_id, step_id } = await setupSimpleRequest();
    const out = await decide(sb, { request_id, step_id, decision: "request_changes", notes: "fix it" }, { actor_user_id: ADMIN });
    expect(out.finalized).toBe(false);
    expect(state.approval_requests[0].status).toBe("pending");
    expect(state.approval_decisions).toHaveLength(1);
    expect(state.approval_decisions[0].notes).toBe("fix it");
  });
});

describe("cancel", () => {
  async function setupRequest() {
    const { state, sb } = seed();
    state.approval_rules.push({
      id: "r1", entity_id: ENTITY, kind: "ap_invoice", is_active: true,
      match: {}, steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
    });
    const r = await requestIfRequired(sb, {
      kind: "ap_invoice", entity_id: ENTITY,
      context_table: "invoices", context_id: "inv-1",
      amount_cents: 100, created_by_user_id: ACTOR,
    });
    return { state, sb, request_id: r.request_id };
  }

  it("owner can cancel", async () => {
    const { sb, state, request_id } = await setupRequest();
    const out = await cancel(sb, { request_id }, { actor_user_id: ACTOR });
    expect(out.request.status).toBe("cancelled");
    expect(state.approval_requests[0].status).toBe("cancelled");
  });

  it("admin (non-owner) can cancel", async () => {
    const { sb, request_id } = await setupRequest();
    const out = await cancel(sb, { request_id }, { actor_user_id: ADMIN });
    expect(out.request.status).toBe("cancelled");
  });

  it("staff (non-owner non-admin) cannot cancel", async () => {
    const { sb, request_id } = await setupRequest();
    await expect(cancel(sb, { request_id }, { actor_user_id: STAFF })).rejects.toThrow(/authorized/);
  });

  it("cannot cancel non-pending request", async () => {
    const { sb, state, request_id } = await setupRequest();
    state.approval_requests[0].status = "approved";
    await expect(cancel(sb, { request_id }, { actor_user_id: ACTOR })).rejects.toThrow(/pending/);
  });
});
