// Tests for the T4-1 menu-usage-decay cron.
//
// Exercises runMenuUsageDecay via a tiny in-memory supabase double.
//   - RPC path (preferred): supabase.rpc('menu_usage_decay_30d') returns N.
//   - Fallback path: select + per-row update when RPC errors.
//   - Empty table -> rows_updated=0.
//   - Errors collected without halting the cron.

import { describe, it, expect, vi } from "vitest";
import { runMenuUsageDecay } from "../../cron/menu-usage-decay.js";

function makeRpcSupabase({ rpcResult = 0, rpcError = null } = {}) {
  const calls = { rpc: [] };
  const sb = {
    calls,
    rpc(name, args) {
      calls.rpc.push({ name, args });
      return Promise.resolve({ data: rpcResult, error: rpcError });
    },
    from() {
      throw new Error("RPC path should not touch from()");
    },
  };
  return sb;
}

function makeFallbackSupabase({ rows = [], selectError = null, updateError = null } = {}) {
  const calls = { rpc: [], select: 0, updates: [] };
  let mutableRows = rows.map((r) => ({ ...r }));

  const builderFor = (table) => {
    if (table !== "user_menu_usage") throw new Error(`unexpected table ${table}`);

    const b = {
      _gt: null,
      select() { return b; },
      gt(col, val) { b._gt = { col, val }; return b; },
      range(from, to) {
        calls.select += 1;
        if (selectError) return Promise.resolve({ data: null, error: selectError });
        const filtered = mutableRows.filter(
          (r) => (b._gt ? r[b._gt.col] > b._gt.val : true),
        );
        return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
      },
      update(patch) {
        b._patch = patch;
        return {
          eq(col, val) { (b._eq = b._eq || []).push([col, val]); return this; },
          _send() {
            calls.updates.push({ patch: b._patch, eq: [...(b._eq || [])] });
            if (updateError) return Promise.resolve({ error: updateError });
            // Apply to mutableRows for state consistency.
            mutableRows = mutableRows.map((r) => {
              const match = (b._eq || []).every(([c, v]) => r[c] === v);
              if (!match) return r;
              return { ...r, ...b._patch };
            });
            b._eq = [];
            return Promise.resolve({ error: null });
          },
          then(resolve) { return this._send().then(resolve); },
        };
      },
    };
    return b;
  };

  return {
    calls,
    rpc() {
      calls.rpc.push({ name: "menu_usage_decay_30d" });
      return Promise.resolve({ data: null, error: { message: "function does not exist" } });
    },
    from: builderFor,
  };
}

describe("runMenuUsageDecay — RPC path", () => {
  it("calls menu_usage_decay_30d RPC and returns rows_updated", async () => {
    const sb = makeRpcSupabase({ rpcResult: 7 });
    const out = await runMenuUsageDecay(sb);
    expect(out.path).toBe("rpc");
    expect(out.rows_updated).toBe(7);
    expect(out.errors).toEqual([]);
    expect(sb.calls.rpc[0].name).toBe("menu_usage_decay_30d");
  });

  it("handles RPC returning an object with rows_updated field", async () => {
    const sb = makeRpcSupabase({ rpcResult: { rows_updated: 42 } });
    const out = await runMenuUsageDecay(sb);
    expect(out.path).toBe("rpc");
    expect(out.rows_updated).toBe(42);
  });

  it("handles RPC returning 0 (no rows decayed)", async () => {
    const sb = makeRpcSupabase({ rpcResult: 0 });
    const out = await runMenuUsageDecay(sb);
    expect(out.path).toBe("rpc");
    expect(out.rows_updated).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it("handles RPC returning a non-numeric blob defensively (rows_updated=0)", async () => {
    const sb = makeRpcSupabase({ rpcResult: "garbage" });
    const out = await runMenuUsageDecay(sb);
    expect(out.path).toBe("rpc");
    expect(out.rows_updated).toBe(0);
  });
});

describe("runMenuUsageDecay — fallback path (RPC missing)", () => {
  it("falls back to select+update when the RPC errors", async () => {
    const rows = [
      { user_id: "u1", entity_id: "e1", menu_key: "tangerine:trial-balance", click_count_30d: 30 },
      { user_id: "u1", entity_id: "e1", menu_key: "ats:planning", click_count_30d: 10 },
    ];
    const sb = makeFallbackSupabase({ rows });
    const out = await runMenuUsageDecay(sb);
    expect(out.path).toBe("fallback");
    expect(out.rows_updated).toBe(2);
    expect(out.errors).toEqual([]);
    // 30 - ceil(30/30)=29 ; 10 - ceil(10/30)=9
    const patched = sb.calls.updates.map((u) => u.patch.click_count_30d).sort((a, b) => a - b);
    expect(patched).toEqual([9, 29]);
  });

  it("decays via ceil(count/30), floored at 0", async () => {
    const rows = [
      { user_id: "u1", entity_id: "e1", menu_key: "a", click_count_30d: 1 },   // ceil(1/30)=1 -> 0
      { user_id: "u1", entity_id: "e1", menu_key: "b", click_count_30d: 60 },  // ceil(60/30)=2 -> 58
      { user_id: "u1", entity_id: "e1", menu_key: "c", click_count_30d: 31 },  // ceil(31/30)=2 -> 29
    ];
    const sb = makeFallbackSupabase({ rows });
    const out = await runMenuUsageDecay(sb);
    expect(out.rows_updated).toBe(3);
    const patched = sb.calls.updates.map((u) => u.patch.click_count_30d).sort((x, y) => x - y);
    expect(patched).toEqual([0, 29, 58]);
  });

  it("empty table -> success with rows_updated=0", async () => {
    const sb = makeFallbackSupabase({ rows: [] });
    const out = await runMenuUsageDecay(sb);
    expect(out.path).toBe("fallback");
    expect(out.rows_updated).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it("only scans rows with click_count_30d > 0 (filter applied)", async () => {
    const rows = [
      { user_id: "u1", entity_id: "e1", menu_key: "live", click_count_30d: 5 },
      { user_id: "u1", entity_id: "e1", menu_key: "zero", click_count_30d: 0 },
    ];
    const sb = makeFallbackSupabase({ rows });
    await runMenuUsageDecay(sb);
    // Only the live row is touched.
    expect(sb.calls.updates.length).toBe(1);
    expect(sb.calls.updates[0].eq.find(([c]) => c === "menu_key")[1]).toBe("live");
  });

  it("collects select error and returns without halting", async () => {
    const sb = makeFallbackSupabase({
      rows: [],
      selectError: { message: "boom" },
    });
    const out = await runMenuUsageDecay(sb);
    expect(out.path).toBe("fallback");
    expect(out.rows_updated).toBe(0);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/select failed: boom/);
  });

  it("collects per-row update error and continues", async () => {
    const rows = [
      { user_id: "u1", entity_id: "e1", menu_key: "a", click_count_30d: 30 },
      { user_id: "u1", entity_id: "e1", menu_key: "b", click_count_30d: 30 },
    ];
    const sb = makeFallbackSupabase({
      rows,
      updateError: { message: "rls denied" },
    });
    const out = await runMenuUsageDecay(sb);
    // Both rows attempted, both failed — rows_updated stays 0, errors collect both.
    expect(out.rows_updated).toBe(0);
    expect(out.errors.length).toBe(2);
    expect(out.errors[0]).toMatch(/update .*: rls denied/);
  });
});

describe("runMenuUsageDecay — exported handler shape", () => {
  it("exports a default Vercel handler with maxDuration config", async () => {
    const mod = await import("../../cron/menu-usage-decay.js");
    expect(typeof mod.default).toBe("function");
    expect(mod.config).toBeDefined();
    expect(mod.config.maxDuration).toBe(60);
  });

  it("rejects non-GET/POST with 405", async () => {
    const mod = await import("../../cron/menu-usage-decay.js");
    const res = mockRes();
    const req = { method: "DELETE", headers: {} };
    await mod.default(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("GET, POST");
  });

  it("returns 500 when env is missing", async () => {
    const mod = await import("../../cron/menu-usage-decay.js");
    const prevUrl = process.env.VITE_SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const res = mockRes();
      await mod.default({ method: "GET", headers: {} }, res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toMatch(/Server not configured/);
    } finally {
      if (prevUrl !== undefined) process.env.VITE_SUPABASE_URL = prevUrl;
      if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    }
  });
});

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
