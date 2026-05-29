// Tangerine P10-8 — reports entity-scoping audit tests.
//
// Verifies that each financial-report handler honors X-Entity-ID and falls
// back to ROF when absent. The patched handlers each export their own
// `resolveReportEntityId(admin, req)` helper; the tests construct a tiny
// mock admin that records its query path so we can prove the right entity
// gets selected.

import { describe, it, expect } from "vitest";
import { resolveReportEntityId as resolveTB } from "../../_handlers/internal/trial-balance/index.js";
import { resolveReportEntityId as resolveIS } from "../../_handlers/internal/income-statement/index.js";
import { resolveReportEntityId as resolveBS } from "../../_handlers/internal/balance-sheet/index.js";
import { resolveReportEntityId as resolveCF } from "../../_handlers/internal/cash-flow/index.js";
import { verifyAccountEntity } from "../../_handlers/internal/gl-detail/index.js";

const ROF_ID = "11111111-1111-1111-1111-111111111111";
const SBX_ID = "22222222-2222-2222-2222-222222222222";

function makeAdmin({ entitiesById = {}, entitiesByCode = {}, accountsById = {} } = {}) {
  function from(table) {
    const state = { eqs: [] };
    const chain = {
      select() { return chain; },
      eq(col, val) { state.eqs.push([col, val]); return chain; },
      async maybeSingle() {
        if (table === "entities" && state.eqs[0]?.[0] === "id") {
          const v = state.eqs[0][1];
          return { data: entitiesById[v] || null, error: null };
        }
        if (table === "entities" && state.eqs[0]?.[0] === "code") {
          const v = state.eqs[0][1];
          return { data: entitiesByCode[v] || null, error: null };
        }
        if (table === "gl_accounts" && state.eqs[0]?.[0] === "id") {
          const v = state.eqs[0][1];
          return { data: accountsById[v] || null, error: null };
        }
        return { data: null, error: null };
      },
    };
    return chain;
  }
  return { from };
}

const DEFAULT_ENTITIES = {
  entitiesById: {
    [ROF_ID]: { id: ROF_ID },
    [SBX_ID]: { id: SBX_ID },
  },
  entitiesByCode: {
    ROF: { id: ROF_ID },
  },
};

describe("P10-8 trial-balance.resolveReportEntityId", () => {
  it("returns X-Entity-ID when header present and entity exists", async () => {
    const admin = makeAdmin(DEFAULT_ENTITIES);
    const req = { headers: { "x-entity-id": SBX_ID } };
    expect(await resolveTB(admin, req)).toBe(SBX_ID);
  });

  it("falls back to ROF when header absent", async () => {
    const admin = makeAdmin(DEFAULT_ENTITIES);
    expect(await resolveTB(admin, { headers: {} })).toBe(ROF_ID);
  });

  it("falls back to ROF when header points at a non-existent entity", async () => {
    const admin = makeAdmin(DEFAULT_ENTITIES);
    const req = { headers: { "x-entity-id": "99999999-9999-9999-9999-999999999999" } };
    expect(await resolveTB(admin, req)).toBe(ROF_ID);
  });

  it("handles the canonical-cased header name (X-Entity-ID)", async () => {
    const admin = makeAdmin(DEFAULT_ENTITIES);
    const req = { headers: { "X-Entity-ID": SBX_ID } };
    expect(await resolveTB(admin, req)).toBe(SBX_ID);
  });
});

describe("P10-8 income-statement.resolveReportEntityId", () => {
  it("respects X-Entity-ID", async () => {
    const admin = makeAdmin(DEFAULT_ENTITIES);
    expect(await resolveIS(admin, { headers: { "x-entity-id": SBX_ID } })).toBe(SBX_ID);
  });

  it("falls back to ROF when absent", async () => {
    expect(await resolveIS(makeAdmin(DEFAULT_ENTITIES), { headers: {} })).toBe(ROF_ID);
  });

  it("returns null when entities table is empty (smoke for 500 path)", async () => {
    const admin = makeAdmin({ entitiesById: {}, entitiesByCode: {} });
    expect(await resolveIS(admin, { headers: {} })).toBeNull();
  });
});

describe("P10-8 balance-sheet.resolveReportEntityId", () => {
  it("respects X-Entity-ID", async () => {
    expect(await resolveBS(makeAdmin(DEFAULT_ENTITIES), { headers: { "x-entity-id": SBX_ID } })).toBe(SBX_ID);
  });
  it("falls back to ROF when absent", async () => {
    expect(await resolveBS(makeAdmin(DEFAULT_ENTITIES), { headers: {} })).toBe(ROF_ID);
  });
  it("trims whitespace from the header value", async () => {
    expect(await resolveBS(makeAdmin(DEFAULT_ENTITIES), { headers: { "x-entity-id": `  ${SBX_ID}  ` } })).toBe(SBX_ID);
  });
});

describe("P10-8 cash-flow.resolveReportEntityId", () => {
  it("respects X-Entity-ID", async () => {
    expect(await resolveCF(makeAdmin(DEFAULT_ENTITIES), { headers: { "x-entity-id": SBX_ID } })).toBe(SBX_ID);
  });
  it("falls back to ROF when absent", async () => {
    expect(await resolveCF(makeAdmin(DEFAULT_ENTITIES), { headers: {} })).toBe(ROF_ID);
  });
  it("falls back to ROF when header is empty-string (treat as absent)", async () => {
    expect(await resolveCF(makeAdmin(DEFAULT_ENTITIES), { headers: { "x-entity-id": "" } })).toBe(ROF_ID);
  });
});

describe("P10-8 gl-detail.verifyAccountEntity", () => {
  const ACCT_ROF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ACCT_SBX = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const ACCOUNTS = {
    accountsById: {
      [ACCT_ROF]: { entity_id: ROF_ID },
      [ACCT_SBX]: { entity_id: SBX_ID },
    },
  };

  it("permits when header absent (legacy callers)", async () => {
    const r = await verifyAccountEntity(makeAdmin(ACCOUNTS), ACCT_ROF, { headers: {} });
    expect(r.ok).toBe(true);
  });

  it("permits when header matches the account's entity_id", async () => {
    const r = await verifyAccountEntity(makeAdmin(ACCOUNTS), ACCT_ROF, { headers: { "x-entity-id": ROF_ID } });
    expect(r.ok).toBe(true);
  });

  it("refuses 403 when header asserts a different entity than the account", async () => {
    const r = await verifyAccountEntity(makeAdmin(ACCOUNTS), ACCT_ROF, { headers: { "x-entity-id": SBX_ID } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/different entity/i);
  });

  it("returns 404 when the account does not exist", async () => {
    const r = await verifyAccountEntity(makeAdmin(ACCOUNTS), "ffffffff-ffff-ffff-ffff-ffffffffffff", { headers: { "x-entity-id": ROF_ID } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("never bleeds the SANDBOX account into a ROF-scoped request", async () => {
    const r = await verifyAccountEntity(makeAdmin(ACCOUNTS), ACCT_SBX, { headers: { "x-entity-id": ROF_ID } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });
});

describe("P10-8 cross-handler invariants", () => {
  it("all four resolvers prefer header over fallback when both available", async () => {
    const admin = makeAdmin(DEFAULT_ENTITIES);
    const req = { headers: { "x-entity-id": SBX_ID } };
    const results = await Promise.all([
      resolveTB(admin, req),
      resolveIS(admin, req),
      resolveBS(admin, req),
      resolveCF(admin, req),
    ]);
    // All four should pick SBX, not ROF.
    expect(results).toEqual([SBX_ID, SBX_ID, SBX_ID, SBX_ID]);
  });

  it("all four resolvers agree on the same fallback when header absent", async () => {
    const admin = makeAdmin(DEFAULT_ENTITIES);
    const req = { headers: {} };
    const results = await Promise.all([
      resolveTB(admin, req),
      resolveIS(admin, req),
      resolveBS(admin, req),
      resolveCF(admin, req),
    ]);
    expect(results).toEqual([ROF_ID, ROF_ID, ROF_ID, ROF_ID]);
  });
});
