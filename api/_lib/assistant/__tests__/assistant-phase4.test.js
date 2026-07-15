// P28-4-1 — draft-actions plumbing tests. Pure/unit only: no network, no DB
// (the fixture actions' preview/commit never touch the fake admin).
//
// Covers: the confirmation token (sign/verify, tamper, expiry, fail-closed),
// validatePack's actions[] contract, allActionNames/actionByName, the
// run_action executor (read / draft / unknown / not-permitted), the confirm
// endpoint's pure validators (token verify + preview==commit hash check), and
// the tool wiring (run_action looped, present_confirmation terminal).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  canonicalJSON, sha256Hex, signConfirmToken, verifyConfirmToken, isConfirmEnabled,
} from "../confirmToken.js";
import { validatePack, allActionNames, actionByName } from "../registry.js";
import { tool_run_action } from "../../ai/executors-actions.js";
import { validateConfirmedAction } from "../../../_handlers/internal/assistant/actions-confirm.js";
import { TOOLS } from "../../ai/tool-defs.js";
import { TOOL_EXECUTORS } from "../../ai/executors.js";
import { TERMINAL_TOOLS, TOOL_LABELS } from "../../ai/constants.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const OTHER = "22222222-3333-4444-5555-666666666666";
const ENT  = "99999999-8888-7777-6666-555555555555";
const SECRET = "phase4-test-secret";
const fakeAdmin = {}; // fixture preview/commit ignore it

// ── secret gating helpers ─────────────────────────────────────────────────
beforeAll(() => { process.env.TANGERINE_ACTION_CONFIRM_SECRET = SECRET; });
afterAll(() => { delete process.env.TANGERINE_ACTION_CONFIRM_SECRET; });

function withNoSecret(fn) {
  const saved = {
    a: process.env.TANGERINE_ACTION_CONFIRM_SECRET,
    b: process.env.TANGERINE_JWT_SECRET,
    c: process.env.SUPABASE_JWT_SECRET,
  };
  const restore = () => {
    if (saved.a !== undefined) process.env.TANGERINE_ACTION_CONFIRM_SECRET = saved.a;
    if (saved.b !== undefined) process.env.TANGERINE_JWT_SECRET = saved.b;
    if (saved.c !== undefined) process.env.SUPABASE_JWT_SECRET = saved.c;
  };
  delete process.env.TANGERINE_ACTION_CONFIRM_SECRET;
  delete process.env.TANGERINE_JWT_SECRET;
  delete process.env.SUPABASE_JWT_SECRET;
  let result;
  try { result = fn(); }
  catch (e) { restore(); throw e; }
  // Restore only AFTER an async body settles — otherwise the secret is put
  // back before the awaited code inside fn runs.
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

// ── fixture pack + actions ────────────────────────────────────────────────
const readAction = {
  name: "fx_read_action",
  module_key: "finance_misc",
  mode: "read",
  required_action: "read",
  description: "read fixture",
  input_schema: { type: "object", properties: {}, additionalProperties: true },
  preview: async () => ({ summary: "READ SUMMARY", data: { n: 42 }, warnings: [] }),
};

let lastCommit = null;
const writeAction = {
  name: "fx_write_action",
  module_key: "finance_misc",
  mode: "write_confirm",
  required_action: "write",
  description: "write fixture",
  input_schema: { type: "object", properties: { invoice_id: { type: "string" } }, additionalProperties: true },
  preview: async (_db, input) => ({
    summary: "WRITE SUMMARY",
    commit_payload: { chargeback_id: "cb1", invoice_id: input?.invoice_id || "inv1" },
    warnings: [],
  }),
  commit: async (_admin, payload, ctx) => { lastCommit = { payload, ctx }; return { status: 200, body: { ok: true, linked: payload } }; },
};

const fxPacks = [{
  key: "fx",
  label: "Fixture",
  module_keys: ["finance_misc"],
  panels: {},
  actions: [readAction, writeAction],
}];

// ── confirmation token ────────────────────────────────────────────────────
describe("confirmToken canonicalJSON + sha256Hex", () => {
  it("canonicalises regardless of key order", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJSON({ a: 2, b: 1 })).toBe(canonicalJSON({ b: 1, a: 2 }));
    expect(canonicalJSON({ z: { y: 1, x: 2 }, a: [3, 1] })).toBe('{"a":[3,1],"z":{"x":2,"y":1}}');
  });
  it("hashes deterministically and distinctly", () => {
    expect(sha256Hex(canonicalJSON({ a: 1 }))).toBe(sha256Hex(canonicalJSON({ a: 1 })));
    expect(sha256Hex(canonicalJSON({ a: 1 }))).not.toBe(sha256Hex(canonicalJSON({ a: 2 })));
  });
});

describe("signConfirmToken / verifyConfirmToken", () => {
  it("round-trips a valid token and binds the payload hash", () => {
    const token = signConfirmToken({ act: "fx_write_action", commit_payload: { a: 1 }, sub: UUID, ent: ENT });
    expect(token).toBeTruthy();
    const claims = verifyConfirmToken(token);
    expect(claims.act).toBe("fx_write_action");
    expect(claims.sub).toBe(UUID);
    expect(claims.ent).toBe(ENT);
    expect(claims.pl).toEqual({ a: 1 });
    expect(claims.ph).toBe(sha256Hex(canonicalJSON({ a: 1 })));
    expect(typeof claims.jti).toBe("string");
  });
  it("rejects a tampered signature", () => {
    const token = signConfirmToken({ act: "x", commit_payload: { a: 1 }, sub: UUID });
    const parts = token.split(".");
    const flipped = parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A");
    expect(verifyConfirmToken(`${parts[0]}.${parts[1]}.${flipped}`)).toBeNull();
  });
  it("rejects an expired token", () => {
    const token = signConfirmToken({ act: "x", commit_payload: {}, sub: UUID }, { ttlSec: 60, nowSec: 1000 });
    expect(verifyConfirmToken(token, { nowSec: 1050 })).toBeTruthy();  // still inside window
    expect(verifyConfirmToken(token, { nowSec: 2000 })).toBeNull();    // past exp
  });
  it("is fail-closed with no secret (sign null, verify null, disabled)", () => {
    withNoSecret(() => {
      expect(isConfirmEnabled()).toBe(false);
      expect(signConfirmToken({ act: "x", commit_payload: {}, sub: UUID })).toBeNull();
      expect(verifyConfirmToken("a.b.c")).toBeNull();
    });
  });
});

// ── registry actions[] contract ───────────────────────────────────────────
describe("validatePack actions[] contract", () => {
  it("accepts a well-formed action pack", () => {
    expect(validatePack(fxPacks[0])).toEqual([]);
  });
  it("flags a malformed action", () => {
    const bad = {
      key: "bad", label: "Bad", module_keys: ["finance_misc"], panels: {},
      actions: [
        { /* no name */ module_key: "finance_misc", mode: "read", preview: () => {} },
        { name: "b1", module_key: "finance_misc", mode: "nonsense", preview: () => {} },
        { name: "b2", module_key: "finance_misc", mode: "write_confirm", preview: () => {} }, // no commit / required_action
      ],
    };
    const problems = validatePack(bad);
    expect(problems).toContain("action missing name");
    expect(problems).toContain("action b1 has invalid mode");
    expect(problems).toContain("action b2 missing commit()");
    expect(problems).toContain("action b2 needs required_action write|post");
  });
  it("rejects a non-array actions key", () => {
    expect(validatePack({ key: "x", label: "X", module_keys: ["finance_misc"], panels: {}, actions: {} }))
      .toContain("actions must be an array");
  });
});

describe("allActionNames / actionByName", () => {
  it("enumerates + resolves fixture actions", () => {
    expect(allActionNames(fxPacks)).toEqual(["fx_read_action", "fx_write_action"]);
    expect(actionByName("fx_write_action", fxPacks)).toBe(writeAction);
    expect(actionByName("nope", fxPacks)).toBeNull();
  });
  it("real registry ships the P28-4-2 actions", () => {
    const names = allActionNames();
    expect(names).toContain("draft_chargeback_match");
    expect(names).toContain("draft_vendor_email");
    expect(names).toContain("draft_customer_email");
    expect(new Set(names).size).toBe(names.length); // globally unique
  });
});

// ── run_action executor ───────────────────────────────────────────────────
describe("tool_run_action", () => {
  it("read mode returns preview data, no token", async () => {
    const out = await tool_run_action(fakeAdmin, { action: "fx_read_action" }, { packs: fxPacks });
    expect(out).toMatchObject({ mode: "read", summary: "READ SUMMARY", data: { n: 42 } });
    expect(out.token).toBeUndefined();
  });
  it("unknown action returns { error }", async () => {
    const out = await tool_run_action(fakeAdmin, { action: "ghost" }, { packs: fxPacks });
    expect(out).toEqual({ error: "unknown_action" });
  });
  it("advisory RBAC denial returns not_permitted", async () => {
    const out = await tool_run_action(
      fakeAdmin,
      { action: "fx_write_action" },
      { packs: fxPacks, user_id: UUID, entity_id: ENT, permissions: new Set() },
    );
    expect(out).toEqual({ error: "not_permitted" });
  });
  it("write_confirm mode mints a confirmation token bound to the operator", async () => {
    const out = await tool_run_action(
      fakeAdmin,
      { action: "fx_write_action", input: { invoice_id: "inv9" } },
      { packs: fxPacks, user_id: UUID, entity_id: ENT, permissions: new Set(["finance_misc:write"]) },
    );
    expect(out.status).toBe("needs_confirmation");
    expect(out.summary).toBe("WRITE SUMMARY");
    expect(out.action).toBe("fx_write_action");
    const claims = verifyConfirmToken(out.token);
    expect(claims.sub).toBe(UUID);
    expect(claims.ent).toBe(ENT);
    expect(claims.act).toBe("fx_write_action");
    expect(claims.pl).toEqual({ chargeback_id: "cb1", invoice_id: "inv9" });
  });
  it("is fail-closed with no secret (write unavailable, preview still ran)", async () => {
    await withNoSecret(async () => {
      const out = await tool_run_action(
        fakeAdmin,
        { action: "fx_write_action" },
        { packs: fxPacks, user_id: UUID, entity_id: ENT, permissions: new Set(["finance_misc:write"]) },
      );
      expect(out.status).toBe("unavailable");
      expect(out.error).toBe("confirm_unavailable");
      expect(out.summary).toBe("WRITE SUMMARY");
    });
  });
});

// ── confirm endpoint pure validators ──────────────────────────────────────
describe("validateConfirmedAction", () => {
  const payload = { chargeback_id: "cb1", invoice_id: "inv1" };
  const mint = (over = {}) => signConfirmToken({ act: "fx_write_action", commit_payload: payload, sub: UUID, ent: ENT, ...over });

  it("accepts a valid token + matching payload", () => {
    const r = validateConfirmedAction({ token: mint(), commit_payload: payload, callerId: UUID, packs: fxPacks });
    expect(r.ok).toBe(true);
    expect(r.action).toBe(writeAction);
    expect(r.commit_payload).toEqual(payload);
  });
  it("uses the token-carried payload when the caller omits it", () => {
    const r = validateConfirmedAction({ token: mint(), callerId: UUID, packs: fxPacks });
    expect(r.ok).toBe(true);
    expect(r.commit_payload).toEqual(payload);
  });
  it("409s on preview!=commit payload drift", () => {
    const r = validateConfirmedAction({
      token: mint(), commit_payload: { chargeback_id: "cb1", invoice_id: "HACKED" }, callerId: UUID, packs: fxPacks,
    });
    expect(r).toMatchObject({ ok: false, status: 409, error: "payload_drift" });
  });
  it("403s when the confirmer is not the previewer (sub mismatch)", () => {
    const r = validateConfirmedAction({ token: mint(), commit_payload: payload, callerId: OTHER, packs: fxPacks });
    expect(r).toMatchObject({ ok: false, status: 403, error: "identity_mismatch" });
  });
  it("401s on an expired token", () => {
    const token = mint({ }); // signed at wall clock
    const r = validateConfirmedAction({ token, callerId: UUID, packs: fxPacks, nowSec: Math.floor(Date.now() / 1000) + 4000 });
    expect(r).toMatchObject({ ok: false, status: 401, error: "invalid_or_expired_token" });
  });
  it("404s an unknown action", () => {
    const token = signConfirmToken({ act: "ghost_action", commit_payload: {}, sub: UUID, ent: ENT });
    const r = validateConfirmedAction({ token, callerId: UUID, packs: fxPacks });
    expect(r).toMatchObject({ ok: false, status: 404, error: "unknown_action" });
  });
  it("400s an action with no commit()", () => {
    const token = signConfirmToken({ act: "fx_read_action", commit_payload: {}, sub: UUID, ent: ENT });
    const r = validateConfirmedAction({ token, callerId: UUID, packs: fxPacks });
    expect(r).toMatchObject({ ok: false, status: 400, error: "action_not_committable" });
  });
  it("503s (fail-closed) with no secret configured", () => {
    withNoSecret(() => {
      const r = validateConfirmedAction({ token: "a.b.c", callerId: UUID, packs: fxPacks });
      expect(r).toMatchObject({ ok: false, status: 503, error: "confirm_unavailable" });
    });
  });
});

// ── tool wiring ───────────────────────────────────────────────────────────
describe("run_action / present_confirmation tool wiring", () => {
  const runAction = TOOLS.find((t) => t.name === "run_action");
  const presentConfirmation = TOOLS.find((t) => t.name === "present_confirmation");

  it("both P28-4 tools are defined", () => {
    expect(runAction).toBeTruthy();
    expect(presentConfirmation).toBeTruthy();
  });
  it("run_action is looped with an executor; present_confirmation is terminal", () => {
    expect(TERMINAL_TOOLS.has("run_action")).toBe(false);
    expect(typeof TOOL_EXECUTORS.run_action).toBe("function");
    expect(TERMINAL_TOOLS.has("present_confirmation")).toBe(true);
    expect(TOOL_EXECUTORS.present_confirmation).toBeUndefined();
  });
  it("run_action's action enum mirrors the registry action allowlist", () => {
    const en = runAction.input_schema.properties.action.enum ?? [];
    expect([...en].sort()).toEqual([...allActionNames()].sort());
  });
  it("present_confirmation carries { summary, token, action }", () => {
    expect(Object.keys(presentConfirmation.input_schema.properties).sort()).toEqual(["action", "summary", "token"]);
    expect(presentConfirmation.input_schema.required.sort()).toEqual(["action", "summary", "token"]);
  });
  it("both tools have friendly stage labels", () => {
    expect(TOOL_LABELS.run_action).toBeTruthy();
    expect(TOOL_LABELS.present_confirmation).toBeTruthy();
  });
});
