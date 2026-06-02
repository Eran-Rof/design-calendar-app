// Tests for api/_lib/auth/resolve-entity.js — the P10-4 entity-resolution
// helper. Covers every priority level (header → default → first → none),
// header validation (case, alias, malformed uuid), membership enforcement,
// and the requireEntity gate.
//
// The mock admin client only stubs the chained `from().select().eq().order()`
// pattern that resolveCallerEntity uses. Other code paths are not exercised
// here — the integration test in P10-5 will cover the end-to-end flow.

import { describe, it, expect } from "vitest";
import {
  resolveCallerEntity,
  readEntityHeader,
  requireEntity,
} from "../resolve-entity.js";

const ENT_A = "11111111-1111-4111-8111-111111111111";
const ENT_B = "22222222-2222-4222-8222-222222222222";
const ENT_C = "33333333-3333-4333-8333-333333333333";
const ENT_UNKNOWN = "99999999-9999-4999-8999-999999999999";
const AUTH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Builds a Supabase admin stub returning the given entity_users rows. */
function makeAdmin({ rows = [], err = null } = {}) {
  return {
    from(table) {
      if (table !== "entity_users") {
        throw new Error(`Unexpected table: ${table}`);
      }
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        async order() {
          if (err) return { data: null, error: err };
          return { data: rows, error: null };
        },
      };
      return chain;
    },
  };
}

function reqWith(headers = {}) {
  return { headers };
}

describe("readEntityHeader", () => {
  it("returns null when no headers object is present", () => {
    expect(readEntityHeader({})).toBe(null);
  });

  it("returns null when X-Entity-ID is absent", () => {
    expect(readEntityHeader(reqWith({ authorization: "Bearer x" }))).toBe(null);
  });

  it("reads lower-case x-entity-id (Vercel/Node default)", () => {
    expect(readEntityHeader(reqWith({ "x-entity-id": ENT_A }))).toBe(ENT_A);
  });

  it("reads canonical-case X-Entity-ID (some test harnesses)", () => {
    expect(readEntityHeader(reqWith({ "X-Entity-ID": ENT_A }))).toBe(ENT_A);
  });

  it("falls back to x-tangerine-entity-id alias", () => {
    expect(readEntityHeader(reqWith({ "x-tangerine-entity-id": ENT_B }))).toBe(
      ENT_B,
    );
  });

  it("trims whitespace around the value", () => {
    expect(readEntityHeader(reqWith({ "x-entity-id": `  ${ENT_A}  ` }))).toBe(
      ENT_A,
    );
  });

  it("returns null on an empty-string header", () => {
    expect(readEntityHeader(reqWith({ "x-entity-id": "   " }))).toBe(null);
  });
});

describe("resolveCallerEntity — priority (1) header", () => {
  it("honours X-Entity-ID when caller is a member", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_A, is_default: true, created_at: "2026-01-01" },
        { entity_id: ENT_B, is_default: false, created_at: "2026-02-01" },
      ],
    });
    const r = await resolveCallerEntity(
      reqWith({ "x-entity-id": ENT_B }),
      admin,
      AUTH_ID,
    );
    expect(r).toEqual({
      entity_id: ENT_B,
      source: "header",
      header_value: ENT_B,
      row_count: 2,
    });
  });

  it("honours X-Entity-ID even when it matches the default row", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_A, is_default: true, created_at: "2026-01-01" },
      ],
    });
    const r = await resolveCallerEntity(
      reqWith({ "x-entity-id": ENT_A }),
      admin,
      AUTH_ID,
    );
    expect(r.source).toBe("header");
    expect(r.entity_id).toBe(ENT_A);
  });

  it("denies a header pointing at an entity the caller does NOT belong to", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_A, is_default: true, created_at: "2026-01-01" },
      ],
    });
    const r = await resolveCallerEntity(
      reqWith({ "x-entity-id": ENT_UNKNOWN }),
      admin,
      AUTH_ID,
    );
    expect(r.entity_id).toBe(null);
    expect(r.source).toBe("denied");
    expect(r.header_value).toBe(ENT_UNKNOWN);
    expect(r.row_count).toBe(1);
  });

  it("ignores a malformed uuid header and falls through to default", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_A, is_default: true, created_at: "2026-01-01" },
      ],
    });
    const r = await resolveCallerEntity(
      reqWith({ "x-entity-id": "not-a-uuid" }),
      admin,
      AUTH_ID,
    );
    expect(r.entity_id).toBe(ENT_A);
    expect(r.source).toBe("default");
    expect(r.header_value).toBe("not-a-uuid");
  });
});

describe("resolveCallerEntity — priority (2) default", () => {
  it("returns the row flagged is_default = true", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_A, is_default: false, created_at: "2026-01-01" },
        { entity_id: ENT_B, is_default: true,  created_at: "2026-02-01" },
        { entity_id: ENT_C, is_default: false, created_at: "2026-03-01" },
      ],
    });
    const r = await resolveCallerEntity(reqWith(), admin, AUTH_ID);
    expect(r).toEqual({
      entity_id: ENT_B,
      source: "default",
      header_value: null,
      row_count: 3,
    });
  });

  it("uses default even when header is absent and multiple rows exist", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_A, is_default: true,  created_at: "2026-01-01" },
        { entity_id: ENT_B, is_default: false, created_at: "2026-02-01" },
      ],
    });
    const r = await resolveCallerEntity(reqWith(), admin, AUTH_ID);
    expect(r.source).toBe("default");
    expect(r.entity_id).toBe(ENT_A);
  });
});

describe("resolveCallerEntity — priority (3) first", () => {
  it("falls back to the first row (by created_at ASC) when no default flag is set", async () => {
    const admin = makeAdmin({
      rows: [
        // resolveCallerEntity asks Supabase to order by created_at ASC so
        // the stub returns rows already in that order; the FIRST one wins.
        { entity_id: ENT_A, is_default: false, created_at: "2026-01-01" },
        { entity_id: ENT_B, is_default: false, created_at: "2026-02-01" },
      ],
    });
    const r = await resolveCallerEntity(reqWith(), admin, AUTH_ID);
    expect(r).toEqual({
      entity_id: ENT_A,
      source: "first",
      header_value: null,
      row_count: 2,
    });
  });

  it("uses first when caller has exactly one row and no default flag", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_C, is_default: false, created_at: "2026-01-01" },
      ],
    });
    const r = await resolveCallerEntity(reqWith(), admin, AUTH_ID);
    expect(r.source).toBe("first");
    expect(r.entity_id).toBe(ENT_C);
    expect(r.row_count).toBe(1);
  });
});

describe("resolveCallerEntity — priority (4) none", () => {
  it("returns source 'none' with null entity_id when caller has zero rows", async () => {
    const admin = makeAdmin({ rows: [] });
    const r = await resolveCallerEntity(reqWith(), admin, AUTH_ID);
    expect(r).toEqual({
      entity_id: null,
      source: "none",
      header_value: null,
      row_count: 0,
    });
  });

  it("returns 'none' even when an unparseable header is present", async () => {
    const admin = makeAdmin({ rows: [] });
    const r = await resolveCallerEntity(
      reqWith({ "x-entity-id": "garbage" }),
      admin,
      AUTH_ID,
    );
    // No rows means we never look at the header for membership.
    expect(r.source).toBe("none");
    expect(r.entity_id).toBe(null);
  });
});

describe("resolveCallerEntity — multi-entity user matrix", () => {
  it("3-entity user, valid header to non-default entity → header wins", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_A, is_default: true,  created_at: "2026-01-01" },
        { entity_id: ENT_B, is_default: false, created_at: "2026-02-01" },
        { entity_id: ENT_C, is_default: false, created_at: "2026-03-01" },
      ],
    });
    const r = await resolveCallerEntity(
      reqWith({ "x-entity-id": ENT_C }),
      admin,
      AUTH_ID,
    );
    expect(r.entity_id).toBe(ENT_C);
    expect(r.source).toBe("header");
    expect(r.row_count).toBe(3);
  });

  it("3-entity user, no header → default flagged row wins regardless of created_at order", async () => {
    const admin = makeAdmin({
      rows: [
        { entity_id: ENT_A, is_default: false, created_at: "2026-01-01" },
        { entity_id: ENT_B, is_default: false, created_at: "2026-02-01" },
        { entity_id: ENT_C, is_default: true,  created_at: "2026-03-01" },
      ],
    });
    const r = await resolveCallerEntity(reqWith(), admin, AUTH_ID);
    expect(r.entity_id).toBe(ENT_C);
    expect(r.source).toBe("default");
  });
});

describe("resolveCallerEntity — error handling", () => {
  it("throws a tagged error when the entity_users lookup fails", async () => {
    const admin = makeAdmin({ err: { message: "db down" } });
    await expect(
      resolveCallerEntity(reqWith(), admin, AUTH_ID),
    ).rejects.toMatchObject({
      message: /entity_users lookup failed: db down/,
      code: "ENTITY_LOOKUP_FAILED",
    });
  });
});

describe("requireEntity gate", () => {
  it("returns null when entity_id is set (allow)", () => {
    expect(
      requireEntity({ entity_id: ENT_A, source: "default" }),
    ).toBe(null);
  });

  it("returns 403 with denied-shaped error when source is 'denied'", () => {
    const gate = requireEntity({
      entity_id: null,
      source: "denied",
      header_value: ENT_UNKNOWN,
    });
    expect(gate).toMatchObject({
      status: 403,
      source: "denied",
    });
    expect(gate.error).toMatch(/does not match/);
  });

  it("returns 403 with no-entity-context error when source is 'none'", () => {
    const gate = requireEntity({ entity_id: null, source: "none" });
    expect(gate).toMatchObject({
      status: 403,
      source: "none",
    });
    expect(gate.error).toMatch(/no entity context/);
  });

  it("treats undefined ctx as 'no entity context' (defensive)", () => {
    const gate = requireEntity(undefined);
    expect(gate.status).toBe(403);
    expect(gate.source).toBe("none");
  });

  it("treats null ctx as 'no entity context' (defensive)", () => {
    const gate = requireEntity(null);
    expect(gate.status).toBe(403);
  });
});

describe("resolveCallerEntity — return-shape contract", () => {
  it("always returns the four documented keys (header path)", async () => {
    const admin = makeAdmin({
      rows: [{ entity_id: ENT_A, is_default: true, created_at: "2026-01-01" }],
    });
    const r = await resolveCallerEntity(
      reqWith({ "x-entity-id": ENT_A }),
      admin,
      AUTH_ID,
    );
    expect(Object.keys(r).sort()).toEqual(
      ["entity_id", "header_value", "row_count", "source"].sort(),
    );
  });

  it("always returns the four documented keys (none path)", async () => {
    const admin = makeAdmin({ rows: [] });
    const r = await resolveCallerEntity(reqWith(), admin, AUTH_ID);
    expect(Object.keys(r).sort()).toEqual(
      ["entity_id", "header_value", "row_count", "source"].sort(),
    );
  });

  it("source is always one of the documented enum values", async () => {
    const allowed = new Set(["header", "default", "first", "denied", "none"]);
    const scenarios = [
      { rows: [], req: reqWith() }, // none
      {
        rows: [{ entity_id: ENT_A, is_default: true, created_at: "x" }],
        req: reqWith(),
      }, // default
      {
        rows: [{ entity_id: ENT_A, is_default: false, created_at: "x" }],
        req: reqWith(),
      }, // first
      {
        rows: [{ entity_id: ENT_A, is_default: true, created_at: "x" }],
        req: reqWith({ "x-entity-id": ENT_A }),
      }, // header
      {
        rows: [{ entity_id: ENT_A, is_default: true, created_at: "x" }],
        req: reqWith({ "x-entity-id": ENT_UNKNOWN }),
      }, // denied
    ];
    for (const s of scenarios) {
      const r = await resolveCallerEntity(s.req, makeAdmin({ rows: s.rows }), AUTH_ID);
      expect(allowed.has(r.source)).toBe(true);
    }
  });
});
