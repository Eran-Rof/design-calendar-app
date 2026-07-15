// P28-4-4 — draft_ap_payment + draft_case action tests.
//
// AP payment: preview (real/unpaid invoice → payload; unknown/paid/settled →
// none) and commit (the maker-checker routing — 202-held at/above threshold,
// immediate executeApPayment below it, created_by = the confirming operator so
// self-approval is structurally impossible). The heavy posting service
// (executeApPayment) is mocked at its module boundary so the test proves the
// pack's GATE + attribution wiring without re-running the GL posting engine;
// validatePay stays REAL.
//
// Case: preview (valid subject → payload; empty subject → none) + commit
// (inserts, returns case_number). Pure/handler-level, in-memory fake supabase.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ONLY executeApPayment (keep the real validatePay). Must be hoisted above
// the registry import so the pack picks up the mock.
vi.mock("../../../_handlers/internal/ap-invoices/pay.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    executeApPayment: vi.fn(async () => ({
      status: 200,
      body: { payment_id: "pay-1", fully_paid: true, invoice_gl_status: "paid" },
    })),
  };
});

import { PACKS, validatePack, allActionNames, actionByName } from "../registry.js";
import { decide } from "../../approvals/index.js";
import { executeApPayment } from "../../../_handlers/internal/ap-invoices/pay.js";

const apAction = actionByName("draft_ap_payment");
const caseAction = actionByName("draft_case");

// ── Ids ────────────────────────────────────────────────────────────────────
const ENTITY = "00000000-0000-0000-0000-0000000000e1";
const MAKER = "00000000-0000-0000-0000-0000000000aa"; // confirming operator
const CHECKER = "00000000-0000-0000-0000-0000000000bb"; // independent admin
const INV = "11111111-1111-1111-1111-111111111111";
const VENDOR = "22222222-2222-2222-2222-222222222222";

// The ≥ $5,000 ap_payment rule seeded by migration 20260989000000.
const AP_RULE = {
  id: "r-ap", entity_id: ENTITY, kind: "ap_payment", is_active: true,
  match: { min_amount_cents: 500000 },
  steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
};

// ── In-memory fake supabase (chainable, PostgREST-ish) — same shape as the
// JE action test, which is proven against requestIfRequired + decide. ─────────
function buildClient(state) {
  return { from(table) { return new Chain(table, state[table] || (state[table] = []), state); } };
}
class Chain {
  constructor(table, rows, all) {
    this.table = table; this.rows = rows; this.all = all;
    this.filters = []; this.insertRows = null; this.updateData = null;
    this.limitN = null; this.singleFlag = false; this.maybeSingleFlag = false;
  }
  select() { return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
  gt(c, v) { this.filters.push((r) => r[c] > v); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  in(c, vals) { this.filters.push((r) => vals.includes(r[c])); return this; }
  like(c, pat) { const re = new RegExp("^" + String(pat).replace(/%/g, ".*") + "$"); this.filters.push((r) => re.test(String(r[c] ?? ""))); return this; }
  limit(n) { this.limitN = n; return this; }
  order() { return this; }
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

// A fresh state seeded with the entity, the ≥$5k ap_payment rule, both admins,
// a vendor, and ONE posted, open invoice at `total` cents (paid `paid` cents).
function seed({ withRule = true, total = 750000, paid = 0, gl_status = "posted", invoiceNumber = "BILL-4471" } = {}) {
  const state = {
    entities: [{ id: ENTITY, code: "ROF" }],
    approval_rules: withRule ? [AP_RULE] : [],
    approval_requests: [],
    approval_request_steps: [],
    approval_decisions: [],
    entity_users: [
      { id: "eu-maker", auth_id: MAKER, entity_id: ENTITY, role: "admin" },
      { id: "eu-checker", auth_id: CHECKER, entity_id: ENTITY, role: "admin" },
    ],
    vendors: [{ id: VENDOR, name: "Acme Textiles", vendor_code: "ACME" }],
    invoices: [{
      id: INV, entity_id: ENTITY, invoice_number: invoiceNumber, vendor_id: VENDOR,
      gl_status, total_amount_cents: total, paid_amount_cents: paid,
    }],
  };
  return { state, admin: buildClient(state) };
}

beforeEach(() => { executeApPayment.mockClear(); });

// ── Registry contract ────────────────────────────────────────────────────────
describe("registry — draft_ap_payment + draft_case", () => {
  it("all packs (incl. the two new packs) validate cleanly", () => {
    for (const pack of PACKS) expect(validatePack(pack), `pack ${pack.key}`).toEqual([]);
  });
  it("registers draft_ap_payment as a write_confirm action gated on ap_invoices:post", () => {
    expect(allActionNames()).toContain("draft_ap_payment");
    expect(apAction.mode).toBe("write_confirm");
    expect(apAction.module_key).toBe("ap_invoices");
    expect(apAction.required_action).toBe("post");
  });
  it("registers draft_case as a write_confirm action gated on cases:write", () => {
    expect(allActionNames()).toContain("draft_case");
    expect(caseAction.mode).toBe("write_confirm");
    expect(caseAction.module_key).toBe("cases");
    expect(caseAction.required_action).toBe("write");
  });
  it("action names remain globally unique", () => {
    const names = allActionNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

// ── AP payment preview ───────────────────────────────────────────────────────
describe("draft_ap_payment preview", () => {
  it("valid, posted, open invoice → commit_payload present, no viewable uuids", async () => {
    const { admin } = seed({ total: 120000, paid: 0 });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeTruthy();
    expect(out.commit_payload.invoice_id).toBe(INV);
    expect(out.commit_payload.amount_cents).toBe("120000"); // full open balance, string cents
    expect(out.commit_payload.method).toBe("ach");
    expect(out.summary).toContain("Acme Textiles");
    expect(out.summary).toContain("BILL-4471");
    expect(out.summary).toContain("$1,200.00");
    expect(out.summary).toContain("07/14/2026"); // MM/DD/YYYY
    expect(out.summary).not.toContain(INV);   // no viewable uuid
    expect(out.summary).not.toContain(VENDOR);
  });

  it("says it will require approval at/above the $5,000 threshold", async () => {
    const { admin } = seed({ total: 750000 });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeTruthy();
    expect(out.warnings).toContain("requires_approval");
    expect(out.summary).toMatch(/approv/i);
    expect(out.summary).toContain("$5,000.00");
  });

  it("says it pays immediately below the threshold", async () => {
    const { admin } = seed({ total: 100000 });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.warnings).not.toContain("requires_approval");
    expect(out.summary).toMatch(/immediately/i);
  });

  it("uses the remaining open balance on a partially-paid invoice", async () => {
    const { admin } = seed({ total: 100000, paid: 40000 });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload.amount_cents).toBe("60000");
    expect(out.summary).toContain("$600.00");
  });

  it("unknown invoice → NO commit_payload (never invents a bill)", async () => {
    const { admin } = seed();
    const out = await apAction.preview(admin, { invoice_number: "NOPE-9999" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("not_found");
  });

  it("already fully-paid invoice → NO commit_payload", async () => {
    const { admin } = seed({ gl_status: "paid" });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("already_paid");
  });

  it("not-yet-posted invoice → NO commit_payload", async () => {
    const { admin } = seed({ gl_status: "draft" });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("not_payable");
  });

  it("fully-settled (open balance 0) invoice → NO commit_payload", async () => {
    const { admin } = seed({ total: 100000, paid: 100000 });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("already_settled");
  });

  it("refuses an overpayment (amount > open balance) → NO commit_payload", async () => {
    const { admin } = seed({ total: 100000 });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471", amount_cents: 200000 }, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("overpayment");
  });

  it("no invoice reference → asks for one, NO commit_payload", async () => {
    const { admin } = seed();
    const out = await apAction.preview(admin, {}, { entityId: ENTITY, todayISO: "2026-07-14" });
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("missing_invoice");
  });
});

// ── AP payment commit — the maker-checker routing ────────────────────────────
describe("draft_ap_payment commit", () => {
  async function payloadFor(total) {
    const { admin } = seed({ total });
    const out = await apAction.preview(admin, { invoice_number: "BILL-4471" }, { entityId: ENTITY, todayISO: "2026-07-14" });
    return out.commit_payload;
  }

  it("≥ threshold → 202 held, approval attributed to the operator (no payment executed)", async () => {
    const { state, admin } = seed({ total: 750000 });
    const payload = await payloadFor(750000);
    const out = await apAction.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(202);
    expect(out.body.requires_approval).toBe(true);
    expect(out.body.status).toBe("pending_approval");
    expect(out.body.approval_request_id).toBeTruthy();
    // executeApPayment was NOT called — the payment executes only on approval.
    expect(executeApPayment).not.toHaveBeenCalled();
    // created_by = the confirming operator ⇒ self-approval impossible.
    const req = state.approval_requests[0];
    expect(req.created_by_user_id).toBe(MAKER);
    expect(req.kind).toBe("ap_payment");
    expect(req.context_table).toBe("invoices");
    expect(req.context_id).toBe(INV);
    // the pay-param snapshot the decide hook replays on approval
    expect(req.payload.invoice_id).toBe(INV);
    expect(req.payload.amount_cents).toBe("750000");
    expect(req.payload.method).toBe("ach");
    expect(req.payload.created_by_user_id).toBe(MAKER);
  });

  it("held payment cannot be self-approved by the maker, but an independent checker can", async () => {
    const { state, admin } = seed({ total: 900000 });
    const payload = await payloadFor(900000);
    await apAction.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    const request_id = state.approval_requests[0].id;
    const step_id = state.approval_request_steps[0].id;
    await expect(
      decide(admin, { request_id, step_id, decision: "approve" }, { actor_user_id: MAKER }),
    ).rejects.toMatchObject({ code: "self_approval_forbidden" });
    const ok = await decide(admin, { request_id, step_id, decision: "approve" }, { actor_user_id: CHECKER });
    expect(ok.finalized).toBe(true);
    expect(state.approval_requests[0].status).toBe("approved");
  });

  it("< threshold → pays immediately via executeApPayment, created_by = operator", async () => {
    const { state, admin } = seed({ total: 100000 });
    const payload = await payloadFor(100000); // $1,000 < $5,000
    const out = await apAction.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(200);
    expect(executeApPayment).toHaveBeenCalledTimes(1);
    const [, args] = executeApPayment.mock.calls[0];
    expect(args.invoice.id).toBe(INV);
    expect(args.params.amount_cents).toBe("100000");
    expect(args.params.created_by_user_id).toBe(MAKER); // maker attribution
    expect(state.approval_requests).toHaveLength(0);     // no approval below threshold
  });

  it("with no active rule, pays immediately even above $5,000 (no assistant-specific threshold)", async () => {
    const { admin } = seed({ withRule: false, total: 750000 });
    const out = await apAction.commit(admin, await payloadFor(750000), { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(200);
    expect(executeApPayment).toHaveBeenCalledTimes(1);
  });

  it("re-guards an invoice already paid under us (409, no payment)", async () => {
    const { admin } = seed({ gl_status: "paid", total: 100000 });
    // build a payload as if it had been posted, then commit against the paid row
    const payload = { invoice_id: INV, payment_date: "2026-07-14", amount_cents: "100000", method: "ach", bank_account_id: null };
    const out = await apAction.commit(admin, payload, { entityId: ENTITY, userId: MAKER });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe("invoice_already_paid");
    expect(executeApPayment).not.toHaveBeenCalled();
  });

  it("rejects a commit with no resolved entity", async () => {
    const { admin } = seed({ total: 100000 });
    const payload = await payloadFor(100000);
    const out = await apAction.commit(admin, payload, { userId: MAKER });
    expect(out.status).toBe(400);
    expect(out.body.error).toBe("missing_entity");
  });
});

// ── Case: a simple, purpose-built fake (no maker-checker, no money) ───────────
function caseAdmin({ existingCases = [], insertError = null, customer = null } = {}, log) {
  const cases = [...existingCases];
  return {
    from(table) {
      const st = { table, op: "select", payload: null };
      const b = {
        select() { return b; },
        eq() { return b; },
        like() { return b; },
        order() { return b; },
        limit() { return b; },
        insert(p) { st.op = "insert"; st.payload = p; if (log) log.push(p); return b; },
        maybeSingle() { return run(); },
        single() { return run(); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      function run() {
        if (table === "cases") {
          if (st.op === "insert") {
            if (insertError) return { data: null, error: insertError };
            const inserted = { id: "case-1", ...st.payload };
            cases.push(inserted);
            return { data: inserted, error: null };
          }
          return { data: cases.map((c) => ({ case_number: c.case_number })), error: null };
        }
        if (table === "customers") return { data: customer, error: null };
        return { data: null, error: null };
      }
      return b;
    },
  };
}

const CTX = { entityId: ENTITY, userId: MAKER, todayISO: "2026-07-14" };

describe("draft_case preview", () => {
  it("valid subject → commit_payload present", async () => {
    const admin = caseAdmin();
    const out = await caseAction.preview(admin, { subject: "Nordstrom short-shipped PO 4471", severity: "high" }, CTX);
    expect(out.commit_payload).toBeTruthy();
    expect(out.commit_payload.subject).toBe("Nordstrom short-shipped PO 4471");
    expect(out.commit_payload.severity).toBe("high");
    expect(out.commit_payload.status).toBe("open");
    expect(out.summary).toContain("Nordstrom short-shipped PO 4471");
    expect(out.warnings).toEqual([]);
  });

  it("names a linked customer without leaking its id", async () => {
    const admin = caseAdmin({ customer: { name: "Nordstrom", code: "CUST-00042" } });
    const CUSTOMER = "33333333-3333-3333-3333-333333333333";
    const out = await caseAction.preview(admin, { subject: "credit memo question", customer_id: CUSTOMER }, CTX);
    expect(out.commit_payload).toBeTruthy();
    expect(out.summary).toContain("Nordstrom");
    expect(out.summary).not.toContain(CUSTOMER);
  });

  it("empty subject → NO commit_payload", async () => {
    const admin = caseAdmin();
    const out = await caseAction.preview(admin, { subject: "   " }, CTX);
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("missing_subject");
  });

  it("missing subject → NO commit_payload without touching the db", async () => {
    const admin = { from() { throw new Error("should not query"); } };
    const out = await caseAction.preview(admin, {}, CTX);
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("missing_subject");
  });
});

describe("draft_case commit", () => {
  it("inserts the case and returns its case_number, authored by the operator", async () => {
    const log = [];
    const admin = caseAdmin({}, log);
    const out = await caseAction.commit(admin, { subject: "Nordstrom short-shipped PO 4471", severity: "high" }, CTX);
    expect(out.status).toBe(201);
    expect(out.body.ok).toBe(true);
    expect(out.body.case_number).toBe("CASE-2026-00001");
    expect(out.body.subject).toBe("Nordstrom short-shipped PO 4471");
    const inserted = log[0];
    expect(inserted.entity_id).toBe(ENTITY);
    expect(inserted.created_by_user_id).toBe(MAKER); // operator authors the case
    expect(inserted.status).toBe("open");
    expect(inserted.severity).toBe("high");
  });

  it("rejects an empty-subject commit_payload (defense in depth)", async () => {
    const admin = caseAdmin();
    const out = await caseAction.commit(admin, { subject: "" }, CTX);
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/subject/i);
  });

  it("surfaces a duplicate case_number as 409", async () => {
    const admin = caseAdmin({ insertError: { code: "23505", message: "duplicate key" } });
    const out = await caseAction.commit(admin, { subject: "dupe", case_number: "CASE-2026-00007" }, CTX);
    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/already exists/i);
  });
});
