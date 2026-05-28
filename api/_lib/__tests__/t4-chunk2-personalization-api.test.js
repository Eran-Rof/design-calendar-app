// Tests for Cross-cutter T4-2 — Personalization registry + API handlers.
//
// Covers:
//   • menuKeys registry sync between src/lib/menuKeys.ts and api/_lib/menuKeys.js
//   • src/lib/menuKeys.ts shape (no duplicate keys, kebab-case prefixed)
//   • Pure validators on the three writable handlers (favorites, home-route,
//     menu-click) — bad menu_keys → 400, missing fields → 400.
//   • clampLimit on the GET /top endpoint — defaults / clamps high/low.
//   • Full handler integration (mocking @supabase/supabase-js + the
//     authenticateCaller surface) for:
//       - 401 when no Authorization header
//       - 200 happy path on GET /preferences (returns {key:value} map)
//       - 200 happy path on PUT /preferences/favorites (upsert + echo)
//       - 200 happy path on PUT /preferences/home-route (upsert + echo)
//       - 200 happy path on POST /menu-click (RPC path AND fallback path
//         both increment the counter)
//       - 200 happy path on GET /menu-usage/top (orders correctly + clamps
//         the limit)
//
// Same vi.hoisted + vi.mock("@supabase/supabase-js") pattern used by the
// auth-provision test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock state — swap admin instance per test ──────────────────────
const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

// AFTER vi.mock — these imports get the mocked createClient.
const { MENU_KEY_SET, MENU_KEY_LIST, isKnownMenuKey } = await import("../menuKeys.js");
const { MENU_KEYS, MENU_KEY_BY_KEY, MENU_KEYS_VERSION, menuKeysForApp } = await import("../../../src/lib/menuKeys.ts");
const { default: prefsHandler } = await import("../../_handlers/internal/users/me/preferences/index.js");
const { default: favoritesHandler, validateFavoritesBody } = await import("../../_handlers/internal/users/me/preferences/favorites.js");
const { default: homeRouteHandler, validateHomeRouteBody } = await import("../../_handlers/internal/users/me/preferences/home-route.js");
const { default: clickHandler, validateClickBody, incrementClick } = await import("../../_handlers/internal/users/me/menu-click/index.js");
const { default: topHandler, clampLimit } = await import("../../_handlers/internal/users/me/menu-usage/top.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROF_ENTITY_ID = "11111111-1111-1111-1111-111111111111";
const TEST_AUTH_ID  = "22222222-2222-2222-2222-222222222222";

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function makeReq({ method = "GET", body = undefined, authHeader = null, url = "/", query = "" } = {}) {
  return {
    method,
    body,
    url: query ? `${url}?${query}` : url,
    headers: {
      host: "localhost",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
  };
}

// Build a fake supabase admin client whose `from()` returns
// chained query builders. Each table can be configured separately.
function buildAdmin({
  validAuthId   = TEST_AUTH_ID,
  preferences   = [],          // [{ key, value }]
  menuUsage     = [],          // [{ menu_key, click_count_30d, click_count_alltime, last_clicked_at }]
  entityCode    = "ROF",
  entityId      = ROF_ENTITY_ID,
  rpcResult     = null,        // null → RPC fails, fall back to upsert
  rpcError      = { message: "rpc not deployed" },
  upsertError   = null,
  selectError   = null,
} = {}) {
  const calls = {
    upsertPrefs:    [],
    upsertUsage:    [],
    rpcInvocations: [],
    selectPrefs:    0,
    selectUsage:    0,
    selectEntities: 0,
  };

  // Records as a mutable copy so successive calls observe prior writes.
  const prefsRows = preferences.map((r) => ({ ...r }));
  const usageRows = menuUsage.map((r) => ({ ...r }));

  function tableUserPreferences() {
    const state = { filters: [], order: null, limit: null, single: false, maybeSingle: false };
    const builder = {
      select() { return builder; },
      eq(col, val) { state.filters.push([col, val]); return builder; },
      order() { return builder; },
      limit(n) { state.limit = n; return builder; },
      single() { state.single = true; return finish(); },
      maybeSingle() { state.maybeSingle = true; return finish(); },
      then(resolve, reject) { return finish().then(resolve, reject); },
      upsert(row, opts) {
        calls.upsertPrefs.push({ row, opts });
        if (upsertError) return wrapSelect(null, upsertError);
        // Persist in-memory.
        const idx = prefsRows.findIndex(
          (r) => r.user_id === row.user_id && r.entity_id === row.entity_id && r.key === row.key,
        );
        if (idx >= 0) prefsRows[idx] = { ...row };
        else prefsRows.push({ ...row });
        return wrapSelect(row, null);
      },
    };
    function finish() {
      calls.selectPrefs += 1;
      if (selectError) return Promise.resolve({ data: null, error: selectError });
      let rows = prefsRows.filter((r) =>
        state.filters.every(([c, v]) => r[c] === v));
      if (state.single)      return Promise.resolve({ data: rows[0] ?? null, error: null });
      if (state.maybeSingle) return Promise.resolve({ data: rows[0] ?? null, error: null });
      return Promise.resolve({ data: rows, error: null });
    }
    function wrapSelect(row, err) {
      // Chain after .upsert(): .select(...).single() returns the row.
      return {
        select() { return this; },
        single() { return Promise.resolve({ data: row, error: err }); },
        maybeSingle() { return Promise.resolve({ data: row, error: err }); },
        then(resolve, reject) {
          return Promise.resolve({ data: row ? [row] : [], error: err }).then(resolve, reject);
        },
      };
    }
    return builder;
  }

  function tableUserMenuUsage() {
    const state = { filters: [], orderBy: [], limit: null, single: false, maybeSingle: false };
    const builder = {
      select() { return builder; },
      eq(col, val) { state.filters.push([col, val]); return builder; },
      order(col, opts) { state.orderBy.push({ col, asc: opts?.ascending !== false }); return builder; },
      limit(n) { state.limit = n; return finish(); },
      maybeSingle() { state.maybeSingle = true; return finish(); },
      single() { state.single = true; return finish(); },
      then(resolve, reject) { return finish().then(resolve, reject); },
      upsert(row, opts) {
        calls.upsertUsage.push({ row, opts });
        if (upsertError) return wrapSelect(null, upsertError);
        const idx = usageRows.findIndex(
          (r) => r.user_id === row.user_id && r.entity_id === row.entity_id && r.menu_key === row.menu_key,
        );
        if (idx >= 0) usageRows[idx] = { ...row };
        else usageRows.push({ ...row });
        return wrapSelect(row, null);
      },
    };
    function finish() {
      calls.selectUsage += 1;
      if (selectError) return Promise.resolve({ data: null, error: selectError });
      let rows = usageRows.filter((r) =>
        state.filters.every(([c, v]) => r[c] === v));
      for (const { col, asc } of state.orderBy.slice().reverse()) {
        rows.sort((a, b) => {
          const x = a[col]; const y = b[col];
          if (x === y) return 0;
          if (x === undefined || x === null) return asc ? -1 : 1;
          if (y === undefined || y === null) return asc ? 1 : -1;
          return asc ? (x > y ? 1 : -1) : (x < y ? 1 : -1);
        });
      }
      if (state.limit != null) rows = rows.slice(0, state.limit);
      if (state.single)      return Promise.resolve({ data: rows[0] ?? null, error: null });
      if (state.maybeSingle) return Promise.resolve({ data: rows[0] ?? null, error: null });
      return Promise.resolve({ data: rows, error: null });
    }
    function wrapSelect(row, err) {
      return {
        select() { return this; },
        single() { return Promise.resolve({ data: row, error: err }); },
        maybeSingle() { return Promise.resolve({ data: row, error: err }); },
      };
    }
    return builder;
  }

  function tableEntities() {
    const state = { filters: [] };
    const builder = {
      select() { return builder; },
      eq(col, val) { state.filters.push([col, val]); return builder; },
      maybeSingle() {
        calls.selectEntities += 1;
        const codeFilter = state.filters.find((f) => f[0] === "code");
        if (codeFilter && codeFilter[1] === entityCode) {
          return Promise.resolve({ data: { id: entityId }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  }

  return {
    _calls: calls,
    _prefsRows: prefsRows,
    _usageRows: usageRows,
    auth: {
      async getUser(jwt) {
        if (!jwt || jwt === "bad-token") return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id: validAuthId } }, error: null };
      },
    },
    from(table) {
      if (table === "user_preferences") return tableUserPreferences();
      if (table === "user_menu_usage")  return tableUserMenuUsage();
      if (table === "entities")          return tableEntities();
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name, args) {
      calls.rpcInvocations.push({ name, args });
      if (rpcResult != null) return Promise.resolve({ data: rpcResult, error: null });
      return Promise.resolve({ data: null, error: rpcError });
    },
  };
}

// ─── Registry sync ───────────────────────────────────────────────────────────

describe("menu_keys registry sync", () => {
  it("server MENU_KEY_SET matches client MENU_KEYS one-to-one", () => {
    const clientKeys = new Set(MENU_KEYS.map((m) => m.key));
    expect(MENU_KEY_SET.size).toBe(clientKeys.size);
    for (const k of clientKeys) expect(MENU_KEY_SET.has(k)).toBe(true);
    for (const k of MENU_KEY_SET) expect(clientKeys.has(k)).toBe(true);
  });

  it("MENU_KEY_LIST is the canonical iteration order", () => {
    // Ordering is documented to match grouped-by-app — assert it's stable
    // across runs by re-iterating.
    const first = [...MENU_KEY_LIST];
    const second = [...MENU_KEY_SET].sort((a, b) => first.indexOf(a) - first.indexOf(b));
    expect(second).toEqual(first);
  });
});

describe("client MENU_KEYS shape", () => {
  it("has no duplicate keys", () => {
    const seen = new Set();
    for (const m of MENU_KEYS) {
      expect(seen.has(m.key)).toBe(false);
      seen.add(m.key);
    }
  });

  it("every key is kebab-case and app-prefixed", () => {
    const KEY_RE = /^[a-z0-9]+(?:-?[a-z0-9]+)*(?:\/[a-z0-9]+(?:-?[a-z0-9]+)*)+$/;
    for (const m of MENU_KEYS) {
      expect(m.key, m.key).toMatch(KEY_RE);
    }
  });

  it("every entry has a valid app + non-empty label + route", () => {
    const APPS = new Set(["dc", "ats", "powip", "gs1", "tanda"]);
    for (const m of MENU_KEYS) {
      expect(APPS.has(m.app), m.key).toBe(true);
      expect(m.label.length > 0, m.key).toBe(true);
      expect(m.route.startsWith("/"), m.key).toBe(true);
    }
  });

  it("MENU_KEY_BY_KEY is a complete lookup", () => {
    for (const m of MENU_KEYS) {
      expect(MENU_KEY_BY_KEY[m.key]).toBe(m);
    }
  });

  it("menuKeysForApp filters by app", () => {
    const dc = menuKeysForApp("dc");
    expect(dc.length > 0).toBe(true);
    expect(dc.every((m) => m.app === "dc")).toBe(true);
  });

  it("MENU_KEYS_VERSION is a positive integer", () => {
    expect(Number.isInteger(MENU_KEYS_VERSION)).toBe(true);
    expect(MENU_KEYS_VERSION > 0).toBe(true);
  });
});

describe("isKnownMenuKey", () => {
  it("accepts a registered key", () => {
    expect(isKnownMenuKey(MENU_KEYS[0].key)).toBe(true);
  });
  it("rejects an unregistered key", () => {
    expect(isKnownMenuKey("bogus/key")).toBe(false);
  });
  it("rejects non-string input", () => {
    expect(isKnownMenuKey(undefined)).toBe(false);
    expect(isKnownMenuKey(null)).toBe(false);
    expect(isKnownMenuKey(42)).toBe(false);
  });
});

// ─── Pure validators ─────────────────────────────────────────────────────────

describe("validateFavoritesBody", () => {
  it("rejects non-object body", () => {
    expect(validateFavoritesBody(null).error).toMatch(/object/);
    expect(validateFavoritesBody(42).error).toMatch(/object/);
  });
  it("rejects missing keys", () => {
    expect(validateFavoritesBody({}).error).toMatch(/keys/);
  });
  it("rejects non-array keys", () => {
    expect(validateFavoritesBody({ keys: "x" }).error).toMatch(/keys/);
  });
  it("rejects empty-string entries", () => {
    expect(validateFavoritesBody({ keys: [""] }).error).toMatch(/non-empty/);
  });
  it("rejects duplicate entries", () => {
    const k = MENU_KEYS[0].key;
    expect(validateFavoritesBody({ keys: [k, k] }).error).toMatch(/duplicate/);
  });
  it("rejects unknown menu_key", () => {
    expect(validateFavoritesBody({ keys: ["bogus/key"] }).error).toMatch(/unknown menu_key/);
  });
  it("rejects too many entries (>50)", () => {
    const tooMany = [];
    for (let i = 0; i < 51; i++) tooMany.push(MENU_KEYS[i % MENU_KEYS.length].key);
    // Dedupe to avoid duplicate-error first, then pad to 51 unique entries.
    // Test relies on MENU_KEYS having at least 51 unique items.
    const unique = MENU_KEYS.slice(0, 51).map((m) => m.key);
    if (unique.length === 51) {
      expect(validateFavoritesBody({ keys: unique }).error).toMatch(/at most 50/);
    }
  });
  it("accepts a valid keys array", () => {
    const k1 = MENU_KEYS[0].key;
    const k2 = MENU_KEYS[1].key;
    const v = validateFavoritesBody({ keys: [k1, k2] });
    expect(v.error).toBeUndefined();
    expect(v.data.keys).toEqual([k1, k2]);
  });
});

describe("validateHomeRouteBody", () => {
  it("rejects non-object body", () => {
    expect(validateHomeRouteBody(null).error).toMatch(/object/);
  });
  it("rejects missing menu_key", () => {
    expect(validateHomeRouteBody({}).error).toMatch(/menu_key/);
  });
  it("rejects non-string menu_key", () => {
    expect(validateHomeRouteBody({ menu_key: 42 }).error).toMatch(/menu_key/);
  });
  it("rejects unknown menu_key", () => {
    expect(validateHomeRouteBody({ menu_key: "bogus" }).error).toMatch(/unknown/);
  });
  it("accepts a known menu_key", () => {
    const k = MENU_KEYS[0].key;
    const v = validateHomeRouteBody({ menu_key: k });
    expect(v.error).toBeUndefined();
    expect(v.data.menu_key).toBe(k);
  });
});

describe("validateClickBody", () => {
  it("rejects non-object body", () => {
    expect(validateClickBody(null).error).toMatch(/object/);
  });
  it("rejects missing menu_key", () => {
    expect(validateClickBody({}).error).toMatch(/menu_key/);
  });
  it("rejects unknown menu_key", () => {
    expect(validateClickBody({ menu_key: "fake" }).error).toMatch(/unknown/);
  });
  it("accepts a known menu_key", () => {
    expect(validateClickBody({ menu_key: MENU_KEYS[0].key }).error).toBeUndefined();
  });
});

describe("clampLimit", () => {
  it("defaults to 10 when missing", () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(null)).toBe(10);
    expect(clampLimit("")).toBe(10);
  });
  it("defaults when non-numeric", () => {
    expect(clampLimit("not-a-number")).toBe(10);
  });
  it("clamps below 1 up to 1", () => {
    expect(clampLimit("0")).toBe(1);
    expect(clampLimit("-3")).toBe(1);
  });
  it("clamps above 50 down to 50", () => {
    expect(clampLimit("9999")).toBe(50);
    expect(clampLimit(200)).toBe(50);
  });
  it("passes through valid limits", () => {
    expect(clampLimit("25")).toBe(25);
    expect(clampLimit(7)).toBe(7);
  });
  it("floors fractional limits", () => {
    expect(clampLimit("17.9")).toBe(17);
  });
});

// ─── Handler integration ─────────────────────────────────────────────────────

describe("preferences GET handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  });
  afterEach(() => { mockState.admin = null; });

  it("401 when no Authorization header", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ method: "GET", url: "/api/internal/users/me/preferences" });
    const res = makeRes();
    await prefsHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/[Mm]issing/);
  });

  it("401 when JWT is invalid", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({
      method: "GET",
      url: "/api/internal/users/me/preferences",
      authHeader: "Bearer bad-token",
    });
    const res = makeRes();
    await prefsHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("405 on non-GET", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({
      method: "POST",
      url: "/api/internal/users/me/preferences",
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await prefsHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("200 with {key:value} map flattened from rows", async () => {
    const aFavKey = MENU_KEYS[0].key;
    mockState.admin = buildAdmin({
      preferences: [
        { user_id: TEST_AUTH_ID, entity_id: ROF_ENTITY_ID, key: "favorites",  value: { keys: [aFavKey], v: 1 } },
        { user_id: TEST_AUTH_ID, entity_id: ROF_ENTITY_ID, key: "home_route", value: { menu_key: aFavKey, v: 1 } },
      ],
    });
    const req = makeReq({
      method: "GET",
      url: "/api/internal/users/me/preferences",
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await prefsHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.favorites).toEqual({ keys: [aFavKey], v: 1 });
    expect(res.body.home_route).toEqual({ menu_key: aFavKey, v: 1 });
  });

  it("200 with empty object when user has no preferences", async () => {
    mockState.admin = buildAdmin({ preferences: [] });
    const req = makeReq({
      method: "GET",
      url: "/api/internal/users/me/preferences",
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await prefsHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({});
  });
});

describe("favorites PUT handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  });
  afterEach(() => { mockState.admin = null; });

  it("401 when no Authorization header", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ method: "PUT", body: { keys: [] } });
    const res = makeRes();
    await favoritesHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("400 on unknown menu_key", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({
      method: "PUT",
      body: { keys: ["never-registered"] },
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await favoritesHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/unknown/);
  });

  it("400 on missing body", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ method: "PUT", body: {}, authHeader: "Bearer good-token" });
    const res = makeRes();
    await favoritesHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("200 happy path — upserts and echoes the stored row", async () => {
    const admin = buildAdmin();
    mockState.admin = admin;
    const k1 = MENU_KEYS[0].key;
    const k2 = MENU_KEYS[1].key;
    const req = makeReq({
      method: "PUT",
      body: { keys: [k1, k2] },
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await favoritesHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.key).toBe("favorites");
    expect(res.body.value.keys).toEqual([k1, k2]);
    expect(admin._calls.upsertPrefs).toHaveLength(1);
    expect(admin._calls.upsertPrefs[0].row).toMatchObject({
      user_id: TEST_AUTH_ID, entity_id: ROF_ENTITY_ID, key: "favorites",
    });
    expect(admin._calls.upsertPrefs[0].opts).toMatchObject({
      onConflict: "user_id,entity_id,key",
    });
  });

  it("accepts a string-typed JSON body (raw Vercel passthrough)", async () => {
    mockState.admin = buildAdmin();
    const k = MENU_KEYS[0].key;
    const req = makeReq({
      method: "PUT",
      body: JSON.stringify({ keys: [k] }),
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await favoritesHandler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe("home-route PUT handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  });
  afterEach(() => { mockState.admin = null; });

  it("401 when no Authorization header", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ method: "PUT", body: { menu_key: MENU_KEYS[0].key } });
    const res = makeRes();
    await homeRouteHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("400 on unknown menu_key", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({
      method: "PUT",
      body: { menu_key: "nope" },
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await homeRouteHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/unknown/);
  });

  it("200 happy path — upserts and echoes the stored row", async () => {
    const admin = buildAdmin();
    mockState.admin = admin;
    const k = MENU_KEYS[2].key;
    const req = makeReq({
      method: "PUT",
      body: { menu_key: k },
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await homeRouteHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.key).toBe("home_route");
    expect(res.body.value.menu_key).toBe(k);
    expect(admin._calls.upsertPrefs).toHaveLength(1);
    expect(admin._calls.upsertPrefs[0].row).toMatchObject({ key: "home_route" });
  });
});

describe("menu-click POST handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  });
  afterEach(() => { mockState.admin = null; });

  it("401 when no Authorization header", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ method: "POST", body: { menu_key: MENU_KEYS[0].key } });
    const res = makeRes();
    await clickHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("400 on unknown menu_key", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({
      method: "POST",
      body: { menu_key: "bogus" },
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await clickHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("increments via fallback (no RPC) — first click inserts at count 1", async () => {
    const admin = buildAdmin({ rpcResult: null });
    mockState.admin = admin;
    const k = MENU_KEYS[0].key;
    const req = makeReq({
      method: "POST",
      body: { menu_key: k },
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await clickHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.menu_key).toBe(k);
    expect(res.body.click_count_30d).toBe(1);
    expect(res.body.click_count_alltime).toBe(1);
    expect(admin._calls.rpcInvocations[0]).toMatchObject({ name: "menu_usage_increment" });
    expect(admin._calls.upsertUsage).toHaveLength(1);
  });

  it("increments via fallback — second click bumps both counters by 1", async () => {
    const k = MENU_KEYS[0].key;
    const admin = buildAdmin({
      rpcResult: null,
      menuUsage: [{
        user_id: TEST_AUTH_ID, entity_id: ROF_ENTITY_ID, menu_key: k,
        click_count_30d: 3, click_count_alltime: 7,
        last_clicked_at: "2026-05-27T00:00:00.000Z",
      }],
    });
    mockState.admin = admin;
    const req = makeReq({
      method: "POST",
      body: { menu_key: k },
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await clickHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.click_count_30d).toBe(4);
    expect(res.body.click_count_alltime).toBe(8);
  });

  it("uses the RPC path when the RPC succeeds (no fallback writes)", async () => {
    const k = MENU_KEYS[0].key;
    const admin = buildAdmin({
      rpcResult: {
        click_count_30d: 9,
        click_count_alltime: 21,
        last_clicked_at: "2026-05-28T12:34:56.000Z",
      },
    });
    mockState.admin = admin;
    const req = makeReq({
      method: "POST",
      body: { menu_key: k },
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await clickHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.click_count_30d).toBe(9);
    expect(res.body.click_count_alltime).toBe(21);
    // RPC succeeded — fallback select+upsert never ran.
    expect(admin._calls.upsertUsage).toHaveLength(0);
  });
});

describe("incrementClick (direct unit, no handler envelope)", () => {
  it("RPC array shape is unwrapped correctly", async () => {
    const admin = buildAdmin({
      rpcResult: [{ click_count_30d: 5, click_count_alltime: 10, last_clicked_at: "2026-05-28T00:00:00.000Z" }],
    });
    const result = await incrementClick(admin, {
      userId: TEST_AUTH_ID, entityId: ROF_ENTITY_ID, menuKey: MENU_KEYS[0].key,
    });
    expect(result.ok).toBe(true);
    expect(result.row.click_count_30d).toBe(5);
    expect(result.row.click_count_alltime).toBe(10);
  });
});

describe("menu-usage/top GET handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  });
  afterEach(() => { mockState.admin = null; });

  it("401 when no Authorization header", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ method: "GET", url: "/api/internal/users/me/menu-usage/top" });
    const res = makeRes();
    await topHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("200 — orders by click_count_30d DESC, then last_clicked_at DESC", async () => {
    mockState.admin = buildAdmin({
      menuUsage: [
        { user_id: TEST_AUTH_ID, entity_id: ROF_ENTITY_ID, menu_key: MENU_KEYS[0].key, click_count_30d: 1, click_count_alltime: 1, last_clicked_at: "2026-05-28T01:00:00.000Z" },
        { user_id: TEST_AUTH_ID, entity_id: ROF_ENTITY_ID, menu_key: MENU_KEYS[1].key, click_count_30d: 5, click_count_alltime: 5, last_clicked_at: "2026-05-28T02:00:00.000Z" },
        { user_id: TEST_AUTH_ID, entity_id: ROF_ENTITY_ID, menu_key: MENU_KEYS[2].key, click_count_30d: 5, click_count_alltime: 5, last_clicked_at: "2026-05-28T03:00:00.000Z" },
      ],
    });
    const req = makeReq({
      method: "GET",
      url: "/api/internal/users/me/menu-usage/top",
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await topHandler(req, res);
    expect(res.statusCode).toBe(200);
    // Sorted: 5/03:00, 5/02:00, 1/01:00
    expect(res.body.rows.map((r) => r.menu_key)).toEqual([
      MENU_KEYS[2].key, MENU_KEYS[1].key, MENU_KEYS[0].key,
    ]);
  });

  it("clamps limit to MAX (50)", async () => {
    // Build 60 rows so the limit actually matters.
    const rows = [];
    for (let i = 0; i < 60 && i < MENU_KEYS.length; i++) {
      rows.push({
        user_id: TEST_AUTH_ID, entity_id: ROF_ENTITY_ID, menu_key: MENU_KEYS[i].key,
        click_count_30d: 60 - i, click_count_alltime: 60 - i,
        last_clicked_at: "2026-05-28T00:00:00.000Z",
      });
    }
    mockState.admin = buildAdmin({ menuUsage: rows });
    const req = makeReq({
      method: "GET",
      url: "/api/internal/users/me/menu-usage/top",
      authHeader: "Bearer good-token",
      query: "limit=9999",
    });
    const res = makeRes();
    await topHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.rows.length).toBeLessThanOrEqual(50);
  });

  it("uses default limit (10) when query missing", async () => {
    mockState.admin = buildAdmin({ menuUsage: [] });
    const req = makeReq({
      method: "GET",
      url: "/api/internal/users/me/menu-usage/top",
      authHeader: "Bearer good-token",
    });
    const res = makeRes();
    await topHandler(req, res);
    expect(res.body.limit).toBe(10);
  });
});

// ─── routes.js wiring ────────────────────────────────────────────────────────

describe("routes.js wiring", () => {
  // Loading routes.js imports 400+ handler modules; bump the timeout so
  // a cold CI run on a slow machine doesn't trip the default 5s.
  it("registers the 5 T4-2 routes on h421..h425", { timeout: 30_000 }, async () => {
    const { ROUTES } = await import("../../_handlers/routes.js");
    const paths = ROUTES.map((r) => r.pattern);
    expect(paths).toContain("/api/internal/users/me/preferences");
    expect(paths).toContain("/api/internal/users/me/preferences/favorites");
    expect(paths).toContain("/api/internal/users/me/preferences/home-route");
    expect(paths).toContain("/api/internal/users/me/menu-click");
    expect(paths).toContain("/api/internal/users/me/menu-usage/top");
  });
});
