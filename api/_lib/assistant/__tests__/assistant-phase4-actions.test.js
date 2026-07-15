// P28-4-2 — draft-action tests: the chargeback-match action (preview + commit),
// the compose-only email composers, the confirmation token, and the single-use
// replay store. Pure/handler-level with a fake supabase builder — no network.

import { describe, it, expect } from "vitest";

import { PACKS, validatePack, allActionNames, actionByName } from "../registry.js";
import emailDrafts, { composeDraft } from "../packs/email_drafts.js";
import { reserveJti } from "../../../_handlers/internal/assistant/actions-confirm.js";

// ── Fake PostgREST builder ────────────────────────────────────────────────
// resolve(state) => { data?: row[], count?: number, error?: {code,message} }
function fakeAdmin(resolve, log) {
  const make = (table) => {
    const state = { table, op: "select", sel: null, opts: null, filters: [], limit: null, payload: null };
    const b = {
      select(sel, opts) { state.sel = sel; state.opts = opts || null; return b; },
      insert(payload) { state.op = "insert"; state.payload = payload; if (log) log.push({ ...state }); return b; },
      update(payload) { state.op = "update"; state.payload = payload; if (log) log.push({ ...state }); return b; },
      delete() { state.op = "delete"; if (log) log.push({ ...state }); return b; },
      order() { return b; },
      limit(n) { state.limit = n; return b; },
      maybeSingle() {
        return Promise.resolve().then(() => resolve(state)).then((r) => ({
          data: Array.isArray(r?.data) ? (r.data[0] ?? null) : (r?.data ?? null),
          error: r?.error ?? null,
        }));
      },
    };
    b.single = b.maybeSingle;
    for (const op of ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "not", "or"]) {
      b[op] = (...args) => { state.filters.push([op, ...args]); return b; };
    }
    b.then = (res, rej) => Promise.resolve().then(() => resolve(state))
      .then((r) => ({ count: null, data: [], error: null, ...r })).then(res, rej);
    return b;
  };
  return { from: make };
}

const filterEq = (state, col) => (state.filters.find(([o, c]) => o === "eq" && c === col) || [])[2];

const CB_ID = "11111111-1111-1111-1111-111111111111";
const CUST = "22222222-2222-2222-2222-222222222222";
const INV1 = "33333333-3333-3333-3333-333333333333";
const INV2 = "44444444-4444-4444-4444-444444444444";
const USER = "55555555-5555-5555-5555-555555555555";

const action = actionByName("draft_chargeback_match");

// One resolver factory covering every chargeback-action read/write shape.
function cbAdmin({ cb, invoices = [], invoiceCount = null, invoiceById = {}, updateResult = undefined }, log) {
  return fakeAdmin((state) => {
    if (state.table === "factor_chargebacks") {
      if (state.op === "update") {
        return { data: updateResult === undefined ? [{ id: CB_ID, matched_ar_invoice_id: INV1, match_method: "assistant_suggested", disposition: "open" }] : updateResult };
      }
      return { data: cb ? [cb] : [] };
    }
    if (state.table === "ar_invoices") {
      if (state.opts?.head) return { count: invoiceCount == null ? invoices.length : invoiceCount };
      const byId = filterEq(state, "id");
      if (byId) return { data: invoiceById[byId] ? [invoiceById[byId]] : [] };
      return { data: invoices };
    }
    if (state.table === "assistant_action_confirmations") return { error: null };
    throw new Error(`unexpected table ${state.table}`);
  }, log);
}

const OPEN_CB = {
  id: CB_ID, item_num: "ROF-I141259", amount_cents: 41200, customer_id: CUST,
  customer_name: "Macys", disposition: "open", matched_ar_invoice_id: null, cb_date: "2026-05-01", status_history: [],
};

// ── Registry contract for actions ─────────────────────────────────────────

describe("registry action contract", () => {
  it("all packs (incl. action packs) validate cleanly", () => {
    for (const pack of PACKS) expect(validatePack(pack), `pack ${pack.key}`).toEqual([]);
  });
  it("action names are globally unique and resolvable", () => {
    const names = allActionNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("draft_chargeback_match");
    expect(names).toContain("draft_vendor_email");
    expect(actionByName("draft_chargeback_match").mode).toBe("write_confirm");
    expect(actionByName("nope")).toBeNull();
  });
  it("rejects a malformed action pack", () => {
    const bad = { key: "x", label: "X", module_keys: ["finance_misc"], panels: {}, actions: [{ name: "bad", mode: "write_confirm" }] };
    const problems = validatePack(bad);
    expect(problems).toContain("action bad missing preview()");
    expect(problems).toContain("action bad missing commit()");
  });
});

// ── draft_chargeback_match.preview ────────────────────────────────────────

describe("draft_chargeback_match preview", () => {
  it("proposes the single unambiguous invoice (commit_payload present)", async () => {
    const admin = cbAdmin({
      cb: OPEN_CB,
      invoices: [
        { id: INV1, invoice_number: "ROF-I141259", total_amount_cents: 41200 },
        { id: INV2, invoice_number: "ROF-I999999", total_amount_cents: 100 },
      ],
    });
    const out = await action.preview(admin, { chargeback_id: CB_ID }, {});
    expect(out.commit_payload).toEqual({ chargeback_id: CB_ID, matched_ar_invoice_id: INV1 });
    expect(out.summary).toContain("ROF-I141259");
    expect(out.summary).toContain("$412.00");
    expect(out.warnings).toEqual([]);
    // no viewable uuid in operator text
    expect(out.summary).not.toContain(INV1);
  });

  it("proposes nothing when no invoice matches", async () => {
    const admin = cbAdmin({ cb: OPEN_CB, invoices: [{ id: INV2, invoice_number: "ROF-I999999", total_amount_cents: 1 }] });
    const out = await action.preview(admin, { chargeback_id: CB_ID }, {});
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("no_unambiguous_match");
  });

  it("proposes nothing when the key is ambiguous (two invoices share it)", async () => {
    const admin = cbAdmin({
      cb: OPEN_CB,
      invoices: [
        { id: INV1, invoice_number: "ROF-I141259", total_amount_cents: 41200 },
        { id: INV2, invoice_number: "ROF-I141259", total_amount_cents: 41200 }, // collision → ambiguous
      ],
    });
    const out = await action.preview(admin, { chargeback_id: CB_ID }, {});
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("no_unambiguous_match");
  });

  it("guards an already-matched chargeback", async () => {
    const admin = cbAdmin({
      cb: { ...OPEN_CB, matched_ar_invoice_id: INV1 },
      invoiceById: { [INV1]: { invoice_number: "ROF-I141259" } },
    });
    const out = await action.preview(admin, { chargeback_id: CB_ID }, {});
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("already_matched");
    expect(out.summary).toContain("ROF-I141259");
  });

  it("guards a non-open chargeback", async () => {
    const admin = cbAdmin({ cb: { ...OPEN_CB, disposition: "valid" } });
    const out = await action.preview(admin, { chargeback_id: CB_ID }, {});
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("not_open");
  });

  it("declines when the chargeback has no customer scope", async () => {
    const admin = cbAdmin({ cb: { ...OPEN_CB, customer_id: null } });
    const out = await action.preview(admin, { chargeback_id: CB_ID }, {});
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("no_customer_scope");
  });

  it("declines a customer larger than one page (row-cap guard)", async () => {
    const admin = cbAdmin({ cb: OPEN_CB, invoices: [], invoiceCount: 1001 });
    const out = await action.preview(admin, { chargeback_id: CB_ID }, {});
    expect(out.commit_payload).toBeUndefined();
    expect(out.warnings).toContain("customer_too_large");
  });

  it("rejects a non-uuid input without touching the db", async () => {
    const admin = fakeAdmin(() => { throw new Error("should not query"); });
    const out = await action.preview(admin, { chargeback_id: "nope" }, {});
    expect(out.warnings).toContain("bad_input");
  });
});

// ── draft_chargeback_match.commit ─────────────────────────────────────────

describe("draft_chargeback_match commit", () => {
  const payload = { chargeback_id: CB_ID, matched_ar_invoice_id: INV1 };

  it("writes the link and returns the invoice number", async () => {
    const log = [];
    const admin = cbAdmin({
      cb: { id: CB_ID, disposition: "open", matched_ar_invoice_id: null, customer_id: CUST, status_history: [] },
      invoiceById: { [INV1]: { id: INV1, invoice_number: "ROF-I141259", customer_id: CUST } },
    }, log);
    const out = await action.commit(admin, payload, { userId: USER });
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.invoice_number).toBe("ROF-I141259");
    const upd = log.find((l) => l.table === "factor_chargebacks" && l.op === "update");
    expect(upd.payload.match_method).toBe("assistant_suggested");
    expect(upd.payload.matched_ar_invoice_id).toBe(INV1);
    expect(upd.payload.status_history.at(-1)).toMatchObject({ by: USER, field: "matched_ar_invoice_id", to: INV1 });
  });

  it("re-guards a chargeback that is no longer open", async () => {
    const admin = cbAdmin({ cb: { id: CB_ID, disposition: "valid", matched_ar_invoice_id: null, customer_id: CUST, status_history: [] } });
    const out = await action.commit(admin, payload, { userId: USER });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe("chargeback_no_longer_open");
  });

  it("re-guards a chargeback already matched under us", async () => {
    const admin = cbAdmin({ cb: { id: CB_ID, disposition: "open", matched_ar_invoice_id: INV2, customer_id: CUST, status_history: [] } });
    const out = await action.commit(admin, payload, { userId: USER });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe("chargeback_already_matched");
  });

  it("rejects an invoice from a different customer", async () => {
    const admin = cbAdmin({
      cb: { id: CB_ID, disposition: "open", matched_ar_invoice_id: null, customer_id: CUST, status_history: [] },
      invoiceById: { [INV1]: { id: INV1, invoice_number: "X", customer_id: "99999999-9999-9999-9999-999999999999" } },
    });
    const out = await action.commit(admin, payload, { userId: USER });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe("invoice_customer_mismatch");
  });
});

// ── compose email actions (read-mode, no write) ───────────────────────────

describe("email composers", () => {
  it("compose a vendor draft and touch no db", () => {
    const out = composeDraft("vendor", { recipient: "Acme Textiles", topic: "late fabric shipment", key_facts: ["PO 4471 is 2 weeks late", "We need an ETA"] });
    expect(out.draft.to).toBe("Acme Textiles");
    expect(out.draft.subject).toBe("late fabric shipment");
    expect(out.draft.body).toContain("Hi Acme Textiles,");
    expect(out.draft.body).toContain("- PO 4471 is 2 weeks late");
    expect(out.summary).toContain("nothing was sent or saved");
  });

  it("customer preview runs without an admin client", async () => {
    const vendor = emailDrafts.actions.find((a) => a.name === "draft_customer_email");
    const out = await vendor.preview(null, { recipient: "Nordstrom", topic: "credit memo" }, {});
    expect(out.draft.body).toContain("Nordstrom");
    expect(out.draft.body).not.toContain("undefined");
    expect(vendor.mode).toBe("read");
    expect(vendor.commit).toBeUndefined();
  });
});

// The confirmation token itself (sign/verify/tamper/expiry/fail-closed) is
// covered by assistant-phase4.test.js against the shipped P28-4-1 API.

// ── replay store (single-use jti) ─────────────────────────────────────────

describe("replay store reserveJti", () => {
  it("reserves once, then rejects the same jti (409 path)", async () => {
    const used = new Set();
    const admin = fakeAdmin((state) => {
      if (state.table !== "assistant_action_confirmations") throw new Error("wrong table");
      const jti = state.payload?.jti;
      if (used.has(jti)) return { error: { code: "23505", message: "duplicate key value" } };
      used.add(jti);
      return { error: null };
    });
    const first = await reserveJti(admin, { jti: "j1", userId: USER, action: "draft_chargeback_match", entityId: "e1" });
    expect(first).toEqual({ ok: true });
    const second = await reserveJti(admin, { jti: "j1", userId: USER, action: "draft_chargeback_match", entityId: "e1" });
    expect(second).toEqual({ conflict: true });
  });

  it("surfaces a non-conflict db error", async () => {
    const admin = fakeAdmin(() => ({ error: { code: "XX000", message: "boom" } }));
    const out = await reserveJti(admin, { jti: "j2", userId: USER, action: "a" });
    expect(out.error).toBeTruthy();
    expect(out.ok).toBeUndefined();
  });
});
