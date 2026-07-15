// P28-4-3 — draft_manual_je action tests: preview (balance + real-account +
// reason guards) and commit (the maker-checker routing — 202-held at/above
// threshold, immediate post below it, created_by = the confirming operator so
// self-approval is structurally impossible). Pure/handler-level with an
// in-memory fake supabase — no network, no real posting RPC.

import { describe, it, expect } from "vitest";

import { PACKS, validatePack, allActionNames, actionByName } from "../registry.js";
import { decide } from "../../approvals/index.js";

const action = actionByName("draft_manual_je");

// ── Ids ────────────────────────────────────────────────────────────────────
const ENTITY = "00000000-0000-0000-0000-0000000000e1";
const MAKER = "00000000-0000-0000-0000-0000000000aa"; // confirming operator
const CHECKER = "00000000-0000-0000-0000-0000000000bb"; // independent admin
const ACC_4011 = "11111111-1111-1111-1111-111111111111";
const ACC_1105 = "22222222-2222-2222-2222-222222222222";
const ACC_9999 = "33333333-3333-3333-3333-333333333333"; // non-postable roll-up

// The ≥ $5,000 je_manual_post rule seeded by migration 20260989000000.
const JE_RULE = {
  id: "r-je", entity_id: ENTITY, kind: "je_manual_post", is_active: true,
  match: { min_amount_cents: 500000 },
  steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
};

const GL_ACCOUNTS = [
  { id: ACC_4011, code: "4011", name: "Ecom revenue", is_postable: true, status: "active", entity_id: ENTITY },
  { id: ACC_1105, code: "1105", name: "Accounts receivable", is_postable: true, status: "active", entity_id: ENTITY },
  { id: ACC_9999, code: "9999", name: "Revenue (roll-up)", is_postable: false, status: "active", entity_id: ENTITY },
];

// ── In-memory fake supabase (chainable, PostgREST-ish) ─────────────────────
function buildClient(state, opts = {}) {
  return { from(table) { return new Chain(table, state[table] || (state[table] = []), state, opts); } };
}
class Chain {
  constructor(table, rows, all, opts) {
    this.table = table; this.rows = rows; this.all = all; this.opts = opts;
    this.filters = []; this.insertRows = null; this.updateData = null;
    this.limitN = null; this.singleFlag = false; this.maybeSingleFlag = false;
    this.headFlag = false;
  }
  select(_sel, options) { if (options?.head) this.headFlag = true; this.countOpt = options?.count; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  gt(c, v) { this.filters.push((r) => r[c] > v); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  in(c, vals) { this.filters.push((r) => vals.includes(r[c])); return this; }
  limit(n) { this.limitN = n; return this; }
  order() { return this; }
  insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(d) { this.updateData = d; return this; }
  delete() { this.deleteFlag = true; return this; }
  single() { this.singleFlag = true; return this._run(); }
  maybeSingle() { this.maybeSingleFlag = true; return this._run(); }
  then(res, rej) { return this._run().then(res, rej); }
  async _run() {
    if (this.opts.rpcErrOn && this.opts.rpcErrOn === this.table) {
      return { data: null, error: { message: "boom", code: "XX000" } };
    }
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

// A fresh state seeded with the entity, gl accounts, the ≥$5k rule, and both
// admins. Optionally records gl_post_journal_entry RPC calls.
function seed({ withRule = true, posted } = {}) {
  const state = {
    entities: [{ id: ENTITY, code: "ROF" }],
    gl_accounts: GL_ACCOUNTS.map((a) => ({ ...a })),
    approval_rules: withRule ? [JE_RULE] : [],
    approval_requests: [],
    approval_request_steps: [],
    approval_decisions: [],
    entity_users: [
      { id: "eu-maker", auth_id: MAKER, entity_id: ENTITY, role: "admin" },
      { id: "eu-checker", auth_id: CHECKER, entity_id: ENTITY, role: "admin" },
    ],
  };
  const admin = buildClient(state);
  // Stub the posting RPC + audit-context RPC used by postManualJournalEntry.
  admin.rpc = async (fn, args) => {
    if (fn === "gl_post_journal_entry") {
      const jeId = `je-${(state.__je = (state.__je || 0) + 1)}`;
      if (posted) posted.push({ fn, args, jeId });
      return { data: jeId, error: null };
    }
    if (fn === "gl_link_sibling_je") return { data: null, error: null };
    // setAuditSessionVars / expandJeLines internals — no-op stubs.
    return { data: null, error: null };
  };
  return { state, admin };
}

// Two-line balanced input at a given dollar amount (in cents on the debit side).
function balancedInput(cents, extra = {}) {
  return {
    description: "Reclass ecom revenue 4005 to 4011",
    reason: "Month-end channel reclass per memory #1725",
    basis: "ACCRUAL",
    posting_date: "2026-07-14",
    lines: [
      { account_code: "1105", debit_cents: cents },
      { account_code: "4011", credit_cents: cents },
    ],
    ...extra,
  };
}

// ── Registry contract ───────────────────────────────────────────────────────
describe("registry — draft_manual_je", () => {
  it("all packs (incl. je_actions) validate cleanly", () => {
    for (const pack of PACKS) expect(validatePack(pack), `pack ${pack.key}`).toEqual([]);
  });
  it("registers a unique, resolvable write_confirm action gated on je_post:post", () => {
    expect(allActionNames()).toContain("draft_manual_je");
    expect(action.mode).toBe("write_confirm");
    expect(action.module_key).toBe("je_post");
    expect(action.required_action).toBe("post");
  });
});

// ── preview ─────────────────────────────────────────────────────────────────
describe("draft_manual_je preview", () => {
  it("balanced + real accounts + reason → commit_payload present, no viewable uuids", async () => {
    const { admin } = seed();
    const out = await action.preview(admin, balancedInput(60000), { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeTruthy();
    expect(out.commit_payload.lines).toHaveLength(2);
    expect(out.commit_payload.reason).toContain("reclass");
    // debit 60000 cents → "600.00" dollar string in the JE body
    const dr = out.commit_payload.lines.find((l) => l.debit !== "0.00");
    expect(dr.debit).toBe("600.00");
    expect(dr.account_id).toBe(ACC_1105);
    expect(out.summary).toContain("$600.00");
    expect(out.summary).not.toContain(ACC_1105); // no viewable uuid
    expect(out.summary).not.toContain(ENTITY);
  });

  it("says it will require approval at/above the $5,000 threshold", async () => {
    const { admin } = seed();
    const out = await action.preview(admin, balancedInput(750000), { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeTruthy();
    expect(out.warnings).toContain("requires_approval");
    expect(out.summary).toMatch(/approv/i);
    expect(out.summary).toContain("$5,000.00");
  });

  it("says it posts immediately below the threshold", async () => {
    const { admin } = seed();
    const out = await action.preview(admin, balancedInput(100000), { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.warnings).not.toContain("requires_approval");
    expect(out.summary).toMatch(/immediately/i);
  });

  it("unbalanced entry → NO commit_payload + unbalanced warning", async () => {
    const { admin } = seed();
    const input = {
      description: "Bad entry", reason: "test",
      lines: [
        { account_code: "1105", debit_cents: 60000 },
        { account_code: "4011", credit_cents: 50000 }, // 500 != 600
      ],
    };
    const out = await action.preview(admin, input, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("unbalanced");
  });

  it("unknown account code → NO commit_payload (never invents an account)", async () => {
    const { admin } = seed();
    const input = {
      description: "Uses a phantom account", reason: "test",
      lines: [
        { account_code: "1105", debit_cents: 10000 },
        { account_code: "8888", credit_cents: 10000 }, // not in the chart
      ],
    };
    const out = await action.preview(admin, input, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("unknown_account");
    expect(out.summary).toContain("8888");
  });

  it("non-postable (roll-up/inactive) account → NO commit_payload", async () => {
    const { admin } = seed();
    const input = {
      description: "Targets a roll-up", reason: "test",
      lines: [
        { account_code: "1105", debit_cents: 10000 },
        { account_code: "9999", credit_cents: 10000 }, // is_postable=false
      ],
    };
    const out = await action.preview(admin, input, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("account_not_postable");
  });

  it("missing reason (T11) → NO commit_payload", async () => {
    const { admin } = seed();
    const input = { ...balancedInput(60000), reason: "" };
    const out = await action.preview(admin, input, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("missing_reason");
  });

  it("fewer than two lines → NO commit_payload", async () => {
    const { admin } = seed();
    const input = { description: "x", reason: "y", lines: [{ account_code: "1105", debit_cents: 10 }] };
    const out = await action.preview(admin, input, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("too_few_lines");
  });
});

// ── commit — the maker-checker routing ──────────────────────────────────────
describe("draft_manual_je commit", () => {
  // Build a valid commit_payload straight from preview so commit sees the exact
  // body the operator confirmed.
  async function payloadFor(cents) {
    const { admin } = seed();
    const out = await action.preview(admin, balancedInput(cents), { entityId: ENTITY, todayISO: "2026-07-14" });
    return out.commit_payload;
  }

  it("≥ threshold → 202 held, opens an approval_request attributed to the operator (no post)", async () => {
    const posted = [];
    const { state, admin } = seed({ posted });
    const payload = await payloadFor(750000);
    const out = await action.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(202);
    expect(out.body.requires_approval).toBe(true);
    expect(out.body.status).toBe("pending_approval");
    expect(out.body.approval_request_id).toBeTruthy();
    // The ledger was NOT written — the JE posts only on approval.
    expect(posted).toHaveLength(0);
    // created_by = the confirming operator ⇒ self-approval impossible.
    const req = state.approval_requests[0];
    expect(req.created_by_user_id).toBe(MAKER);
    expect(req.kind).toBe("je_manual_post");
    // the full JE snapshot is carried for the decide hook to post on approval
    expect(req.payload.lines).toHaveLength(2);
    expect(req.payload.created_by_user_id).toBe(MAKER);
  });

  it("held request cannot be self-approved by the maker, but an independent checker can", async () => {
    const { state, admin } = seed();
    const payload = await payloadFor(900000);
    await action.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    const request_id = state.approval_requests[0].id;
    const step_id = state.approval_request_steps[0].id;
    // maker approving own request → self_approval_forbidden
    await expect(
      decide(admin, { request_id, step_id, decision: "approve" }, { actor_user_id: MAKER }),
    ).rejects.toMatchObject({ code: "self_approval_forbidden" });
    // a DIFFERENT admin can approve
    const ok = await decide(admin, { request_id, step_id, decision: "approve" }, { actor_user_id: CHECKER });
    expect(ok.finalized).toBe(true);
    expect(state.approval_requests[0].status).toBe("approved");
  });

  it("< threshold → posts immediately through postManualJournalEntry", async () => {
    const posted = [];
    const { state, admin } = seed({ posted });
    const payload = await payloadFor(100000); // $1,000 < $5,000
    const out = await action.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(201);
    expect(Array.isArray(out.body.posted)).toBe(true);
    expect(posted).toHaveLength(1); // gl_post_journal_entry called once (ACCRUAL)
    expect(posted[0].fn).toBe("gl_post_journal_entry");
    // no approval request opened below threshold
    expect(state.approval_requests).toHaveLength(0);
  });

  it("with no active rule, posts immediately even above $5,000 (no assistant-specific threshold)", async () => {
    const posted = [];
    const { admin } = seed({ withRule: false, posted });
    const payload = await payloadFor(750000);
    const out = await action.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(201);
    expect(posted).toHaveLength(1);
  });

  it("rejects a commit_payload missing the T11 reason (defense in depth)", async () => {
    const { admin } = seed();
    const payload = await payloadFor(100000);
    const out = await action.commit(admin, { ...payload, reason: "" }, { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/reason/i);
  });

  it("rejects an unbalanced commit_payload (defense in depth)", async () => {
    const { admin } = seed();
    const payload = await payloadFor(100000);
    // tamper: change one line's credit so it no longer balances
    payload.lines[1].credit = "999.99";
    const out = await action.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/unbalanced/i);
  });

  it("rejects a commit with no resolved entity", async () => {
    const { admin } = seed();
    const payload = await payloadFor(100000);
    const out = await action.commit(admin, payload, { userId: MAKER });
    expect(out.status).toBe(400);
    expect(out.body.error).toBe("missing_entity");
  });
});
