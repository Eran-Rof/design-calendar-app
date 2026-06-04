// Tests for the P18-B B2B portal session chokepoint (api/_lib/b2b/session.js).
// Exercises auth (token verify) + authorization (b2b_accounts lookup, first-login
// binding, inactive/unlinked rejection) against a hand-rolled mock admin client.

import { describe, it, expect, vi } from "vitest";
import { resolveB2BSession, extractBearer } from "../b2b/session.js";

const UID = "11111111-1111-1111-1111-111111111111";
const OTHER_UID = "22222222-2222-2222-2222-222222222222";
const CUSTOMER_ID = "33333333-3333-3333-3333-333333333333";

// Build a mock admin client. `accounts` is the b2b_accounts table contents.
// getUser resolves the token → identity. Records update() calls for assertions.
function mockAdmin({ user, accounts }) {
  const updates = [];
  const admin = {
    updates,
    auth: {
      getUser: vi.fn(async (token) => {
        if (token === "good") return { data: { user }, error: null };
        return { data: { user: null }, error: { message: "bad token" } };
      }),
    },
    from(table) {
      const state = { table, filters: {} };
      const builder = {
        select() { return builder; },
        eq(col, val) { state.filters[col] = val; return builder; },
        ilike(col, val) { state.filters[`ilike:${col}`] = val; return builder; },
        is(col, val) { state.filters[`is:${col}`] = val; return builder; },
        update(patch) { state.patch = patch; return builder; },
        async maybeSingle() {
          if (table === "b2b_accounts") {
            let row = null;
            if (state.filters.auth_user_id) {
              row = accounts.find((a) => a.auth_user_id === state.filters.auth_user_id) || null;
            } else if (state.filters["ilike:email"]) {
              row = accounts.find((a) => (a.email || "").toLowerCase() === String(state.filters["ilike:email"]).toLowerCase()) || null;
            }
            return { data: row, error: null };
          }
          if (table === "customers") return { data: { name: "Acme Wholesale" }, error: null };
          return { data: null, error: null };
        },
        then(resolve) {
          // update().eq().is() resolves as a thenable (fire-and-forget paths)
          if (state.patch) updates.push({ table, patch: state.patch, filters: state.filters });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return admin;
}

const reqWith = (token) => ({ headers: { authorization: token ? `Bearer ${token}` : undefined }, method: "GET" });

describe("extractBearer", () => {
  it("pulls the token", () => expect(extractBearer(reqWith("abc"))).toBe("abc"));
  it("null when missing", () => expect(extractBearer({ headers: {} })).toBeNull());
  it("null when not Bearer", () => expect(extractBearer({ headers: { authorization: "Basic x" } })).toBeNull());
});

describe("resolveB2BSession", () => {
  it("503 when no admin client", async () => {
    const r = await resolveB2BSession(reqWith("good"), null);
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it("401 when no token", async () => {
    const admin = mockAdmin({ user: { id: UID }, accounts: [] });
    const r = await resolveB2BSession(reqWith(null), admin);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("401 when token invalid", async () => {
    const admin = mockAdmin({ user: { id: UID }, accounts: [] });
    const r = await resolveB2BSession(reqWith("bad"), admin);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("403 when authenticated but no b2b_accounts row", async () => {
    const admin = mockAdmin({ user: { id: UID, email: "ghost@x.com" }, accounts: [] });
    const r = await resolveB2BSession(reqWith("good"), admin);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("ok via auth_user_id match, returns server-trusted customer_id", async () => {
    const admin = mockAdmin({
      user: { id: UID, email: "buyer@acme.com" },
      accounts: [{ id: "acc1", auth_user_id: UID, customer_id: CUSTOMER_ID, email: "buyer@acme.com", is_active: true, role: "buyer", can_place_orders: true, display_name: "Jane" }],
    });
    const r = await resolveB2BSession(reqWith("good"), admin);
    expect(r.ok).toBe(true);
    expect(r.customer_id).toBe(CUSTOMER_ID);
    expect(r.account.display_name).toBe("Jane");
  });

  it("first-login: matches by email and BINDS auth_user_id", async () => {
    const admin = mockAdmin({
      user: { id: UID, email: "Buyer@Acme.com" },
      accounts: [{ id: "acc1", auth_user_id: null, customer_id: CUSTOMER_ID, email: "buyer@acme.com", is_active: true, role: "buyer", can_place_orders: false }],
    });
    const r = await resolveB2BSession(reqWith("good"), admin);
    expect(r.ok).toBe(true);
    const bind = admin.updates.find((u) => u.patch.auth_user_id === UID);
    expect(bind).toBeTruthy();
  });

  it("refuses when email matches a row bound to a DIFFERENT identity (no hijack)", async () => {
    const admin = mockAdmin({
      user: { id: UID, email: "buyer@acme.com" },
      accounts: [{ id: "acc1", auth_user_id: OTHER_UID, customer_id: CUSTOMER_ID, email: "buyer@acme.com", is_active: true }],
    });
    // auth_user_id lookup for UID misses; email lookup finds a row bound to OTHER_UID.
    const r = await resolveB2BSession(reqWith("good"), admin);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("403 when account is inactive", async () => {
    const admin = mockAdmin({
      user: { id: UID, email: "buyer@acme.com" },
      accounts: [{ id: "acc1", auth_user_id: UID, customer_id: CUSTOMER_ID, email: "buyer@acme.com", is_active: false }],
    });
    const r = await resolveB2BSession(reqWith("good"), admin);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("403 when account has no customer_id", async () => {
    const admin = mockAdmin({
      user: { id: UID, email: "buyer@acme.com" },
      accounts: [{ id: "acc1", auth_user_id: UID, customer_id: null, email: "buyer@acme.com", is_active: true }],
    });
    const r = await resolveB2BSession(reqWith("good"), admin);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});
