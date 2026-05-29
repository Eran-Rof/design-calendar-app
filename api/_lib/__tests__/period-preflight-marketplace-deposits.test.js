// Tangerine P12-99 — preflight marketplace-deposits augmentation tests.
//
// Covers the JS-side extension to the P5-7 close pre-flight: the
// `unmatched_marketplace_deposits` check that queries shopify_payouts,
// fba_settlements, walmart_settlements, faire_payouts where je_id IS NULL
// AND deposit-date <= period.ends_on.
//
// All four tables are mocked through a tiny Supabase-client stub — no live
// DB needed. Pure helper coverage; full integration is exercised via the
// deploy smoke.

import { describe, it, expect, vi } from "vitest";
import {
  summarize,
  MARKETPLACE_DEPOSIT_TABLES,
  countUnmatchedMarketplaceDeposits,
  buildMarketplaceDepositsRow,
  runPreflight,
} from "../../_handlers/internal/gl-periods/preflight.js";

// ─────────────────────────────────────────────────────────────────────────
// Minimal Supabase client mock — supports .from(table).select(...,
// { head:true, count:'exact' }).eq().is().lte() chains. Each call records
// the table + filters and returns { count, error } based on `counts`.
// ─────────────────────────────────────────────────────────────────────────
function makeMockClient(opts) {
  const counts = opts?.counts || {};
  const errorsFor = opts?.errorsFor || {};
  const rpcResult = opts?.rpcResult || { data: [], error: null };
  const calls = [];

  function chainFor(table) {
    const state = { table, filters: [] };
    const chain = {
      select(_cols, _opts) { state.head = !!_opts?.head; state.countExact = _opts?.count === "exact"; return chain; },
      eq(col, val)         { state.filters.push(["eq", col, val]); return chain; },
      is(col, val)         { state.filters.push(["is", col, val]); return chain; },
      lte(col, val)        { state.filters.push(["lte", col, val]); return chain; },
      gte(col, val)        { state.filters.push(["gte", col, val]); return chain; },
      then(resolve)        {
        calls.push(state);
        if (errorsFor[table]) {
          return resolve({ count: null, error: errorsFor[table] });
        }
        const c = counts[table];
        return resolve({ count: typeof c === "number" ? c : 0, error: null });
      },
    };
    return chain;
  }

  return {
    from(table) { return chainFor(table); },
    rpc(_name, _args) { return Promise.resolve(rpcResult); },
    __calls: calls,
  };
}

const periodFixture = {
  id:        "11111111-1111-1111-1111-111111111111",
  entity_id: "22222222-2222-2222-2222-222222222222",
  starts_on: "2026-05-01",
  ends_on:   "2026-05-31",
  status:    "open",
};

// ─────────────────────────────────────────────────────────────────────────
// summarize() — unchanged shape; verify P12-99 row is counted correctly.
// ─────────────────────────────────────────────────────────────────────────
describe("summarize() — marketplace-deposit row contributes to counts", () => {
  it("blocking pass row bumps `passed`, not failed_blocking", () => {
    const s = summarize([
      { check_name: "unmatched_marketplace_deposits", status: "pass", detail: "", blocking: true },
    ]);
    expect(s.passed).toBe(1);
    expect(s.failed_blocking).toBe(0);
    expect(s.can_close).toBe(true);
  });

  it("blocking fail row sets can_close=false", () => {
    const s = summarize([
      { check_name: "unmatched_marketplace_deposits", status: "fail", detail: "12 deposits…", blocking: true },
    ]);
    expect(s.failed_blocking).toBe(1);
    expect(s.can_close).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MARKETPLACE_DEPOSIT_TABLES catalog
// ─────────────────────────────────────────────────────────────────────────
describe("MARKETPLACE_DEPOSIT_TABLES catalog", () => {
  it("includes exactly the four channel deposit tables", () => {
    expect(MARKETPLACE_DEPOSIT_TABLES.map((t) => t.table).sort()).toEqual([
      "faire_payouts",
      "fba_settlements",
      "shopify_payouts",
      "walmart_settlements",
    ]);
  });

  it("uses per-table date columns matching the migrations", () => {
    const byTable = Object.fromEntries(MARKETPLACE_DEPOSIT_TABLES.map((t) => [t.table, t.dateColumn]));
    expect(byTable.shopify_payouts).toBe("payout_date");
    expect(byTable.fba_settlements).toBe("posted_after");
    expect(byTable.walmart_settlements).toBe("period_end");
    expect(byTable.faire_payouts).toBe("period_end");
  });

  it("each entry has a human label", () => {
    for (const t of MARKETPLACE_DEPOSIT_TABLES) {
      expect(typeof t.label).toBe("string");
      expect(t.label.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// countUnmatchedMarketplaceDeposits()
// ─────────────────────────────────────────────────────────────────────────
describe("countUnmatchedMarketplaceDeposits()", () => {
  it("returns zero counts when every table is empty", async () => {
    const client = makeMockClient({});
    const out = await countUnmatchedMarketplaceDeposits(client, periodFixture);
    expect(out.total).toBe(0);
    for (const t of MARKETPLACE_DEPOSIT_TABLES) {
      expect(out.perTable[t.table]).toBe(0);
    }
    expect(out.errors).toEqual([]);
  });

  it("sums per-table counts into total", async () => {
    const client = makeMockClient({
      counts: {
        shopify_payouts: 3,
        fba_settlements: 5,
        walmart_settlements: 1,
        faire_payouts: 2,
      },
    });
    const out = await countUnmatchedMarketplaceDeposits(client, periodFixture);
    expect(out.total).toBe(11);
    expect(out.perTable.shopify_payouts).toBe(3);
    expect(out.perTable.fba_settlements).toBe(5);
    expect(out.perTable.walmart_settlements).toBe(1);
    expect(out.perTable.faire_payouts).toBe(2);
  });

  it("filters by entity_id, je_id IS NULL, and dateColumn <= ends_on", async () => {
    const client = makeMockClient({ counts: { shopify_payouts: 4 } });
    await countUnmatchedMarketplaceDeposits(client, periodFixture);
    const shopifyCall = client.__calls.find((c) => c.table === "shopify_payouts");
    expect(shopifyCall).toBeTruthy();
    const fs = shopifyCall.filters;
    expect(fs).toContainEqual(["eq", "entity_id", periodFixture.entity_id]);
    expect(fs).toContainEqual(["is", "je_id", null]);
    expect(fs).toContainEqual(["lte", "payout_date", periodFixture.ends_on]);
  });

  it("uses an end-of-day timestamp for fba_settlements (posted_after)", async () => {
    const client = makeMockClient({ counts: { fba_settlements: 1 } });
    await countUnmatchedMarketplaceDeposits(client, periodFixture);
    const fbaCall = client.__calls.find((c) => c.table === "fba_settlements");
    expect(fbaCall).toBeTruthy();
    const lte = fbaCall.filters.find((f) => f[0] === "lte" && f[1] === "posted_after");
    expect(lte).toBeTruthy();
    expect(lte[2]).toBe(`${periodFixture.ends_on}T23:59:59.999Z`);
  });

  it("treats 'does not exist' table errors as zero (graceful degrade)", async () => {
    const client = makeMockClient({
      errorsFor: {
        walmart_settlements: { message: "relation walmart_settlements does not exist" },
      },
      counts: { shopify_payouts: 2 },
    });
    const out = await countUnmatchedMarketplaceDeposits(client, periodFixture);
    expect(out.perTable.walmart_settlements).toBe(0);
    expect(out.total).toBe(2);
    expect(out.errors).toEqual([]);
  });

  it("surfaces non-table-missing errors in the errors array (no throw)", async () => {
    const client = makeMockClient({
      errorsFor: {
        faire_payouts: { message: "permission denied for table faire_payouts" },
      },
    });
    const out = await countUnmatchedMarketplaceDeposits(client, periodFixture);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].table).toBe("faire_payouts");
    expect(out.errors[0].error).toMatch(/permission denied/);
  });

  it("issues exactly one query per deposit table", async () => {
    const client = makeMockClient({});
    await countUnmatchedMarketplaceDeposits(client, periodFixture);
    expect(client.__calls).toHaveLength(MARKETPLACE_DEPOSIT_TABLES.length);
    const tablesQueried = client.__calls.map((c) => c.table).sort();
    expect(tablesQueried).toEqual([
      "faire_payouts",
      "fba_settlements",
      "shopify_payouts",
      "walmart_settlements",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildMarketplaceDepositsRow()
// ─────────────────────────────────────────────────────────────────────────
describe("buildMarketplaceDepositsRow()", () => {
  it("returns a pass row when total === 0 (blocking=true regardless)", () => {
    const row = buildMarketplaceDepositsRow({ perTable: {}, total: 0 });
    expect(row.check_name).toBe("unmatched_marketplace_deposits");
    expect(row.status).toBe("pass");
    expect(row.blocking).toBe(true);
    expect(row.detail).toMatch(/No unmatched marketplace deposits/);
  });

  it("returns a fail row with per-table breakdown when total > 0", () => {
    const row = buildMarketplaceDepositsRow({
      perTable: { shopify_payouts: 2, fba_settlements: 0, walmart_settlements: 1, faire_payouts: 0 },
      total: 3,
    });
    expect(row.status).toBe("fail");
    expect(row.blocking).toBe(true);
    expect(row.detail).toMatch(/3 marketplace deposits unmatched/);
    expect(row.detail).toMatch(/Shopify \(shopify_payouts\): 2/);
    expect(row.detail).toMatch(/Walmart \(walmart_settlements\): 1/);
    // Zero-count tables don't appear in the breakdown.
    expect(row.detail).not.toMatch(/fba_settlements: 0/);
  });

  it("uses singular 'deposit' for total=1", () => {
    const row = buildMarketplaceDepositsRow({
      perTable: { shopify_payouts: 1, fba_settlements: 0, walmart_settlements: 0, faire_payouts: 0 },
      total: 1,
    });
    expect(row.detail).toMatch(/1 marketplace deposit unmatched/);
    expect(row.detail).not.toMatch(/deposits unmatched/);
  });

  it("blocking is true even on pass (D6 reconciliation is mandatory)", () => {
    expect(buildMarketplaceDepositsRow({ perTable: {}, total: 0 }).blocking).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runPreflight() — end-to-end with mocked admin client
// ─────────────────────────────────────────────────────────────────────────
describe("runPreflight()", () => {
  it("merges RPC rows + marketplace-deposits row", async () => {
    const client = makeMockClient({
      rpcResult: { data: [
        { check_name: "accrual_trial_balanced", status: "pass", detail: "ok", blocking: true },
        { check_name: "no_draft_jes",           status: "pass", detail: "ok", blocking: true },
      ], error: null },
      counts: { shopify_payouts: 0, fba_settlements: 0, walmart_settlements: 0, faire_payouts: 0 },
    });
    const out = await runPreflight(client, periodFixture);
    expect(out.error).toBeUndefined();
    const names = out.rows.map((r) => r.check_name);
    expect(names).toContain("accrual_trial_balanced");
    expect(names).toContain("no_draft_jes");
    expect(names).toContain("unmatched_marketplace_deposits");
    expect(out.summary.can_close).toBe(true);
  });

  it("marks can_close=false when any deposit unmatched", async () => {
    const client = makeMockClient({
      rpcResult: { data: [
        { check_name: "accrual_trial_balanced", status: "pass", detail: "ok", blocking: true },
      ], error: null },
      counts: { shopify_payouts: 4 },
    });
    const out = await runPreflight(client, periodFixture);
    expect(out.summary.can_close).toBe(false);
    const dep = out.rows.find((r) => r.check_name === "unmatched_marketplace_deposits");
    expect(dep.status).toBe("fail");
    expect(dep.blocking).toBe(true);
  });

  it("propagates an RPC error rather than augmenting blindly", async () => {
    const client = makeMockClient({
      rpcResult: { data: null, error: { message: "RPC missing in this env" } },
    });
    const out = await runPreflight(client, periodFixture);
    expect(out.error).toMatch(/RPC missing/);
  });

  it("skips marketplace check when period has no ends_on", async () => {
    const client = makeMockClient({
      rpcResult: { data: [], error: null },
      counts: { shopify_payouts: 999 },
    });
    const out = await runPreflight(client, { ...periodFixture, ends_on: null });
    const names = out.rows.map((r) => r.check_name);
    expect(names).not.toContain("unmatched_marketplace_deposits");
  });
});
