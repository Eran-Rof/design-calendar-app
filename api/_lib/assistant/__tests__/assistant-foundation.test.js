// P28-1-1 — capability-pack registry + Today aggregator foundation tests.
// Pure/unit only: fake supabase builder, no network.

import { describe, it, expect } from "vitest";
import { PACKS, validatePack, allProviderKeys, panelKeys, isValidSeverity } from "../registry.js";
import {
  permitsModule, filterDismissed, sortTodos, reduceLatestByDomain, buildToday, todayISO,
} from "../today.js";
import { TANGERINE_MODULES } from "../../tangerineModules.js";

// ── Fake PostgREST builder ────────────────────────────────────────────────
// resolver({table, filters, opts}) => { count?, data?, error? }
function fakeAdmin(resolver) {
  return {
    from(table) {
      const state = { table, filters: [], opts: null };
      const b = {
        select(_sel, opts) { state.opts = opts || null; return b; },
        order() { return b; },
        limit() { return b; },
      };
      for (const op of ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is"]) {
        b[op] = (col, val) => { state.filters.push([op, col, val]); return b; };
      }
      b.then = (res, rej) => Promise.resolve()
        .then(() => resolver(state))
        .then((r) => ({ count: 0, data: [], error: null, ...r }))
        .then(res, rej);
      return b;
    },
  };
}

const filterVal = (state, op, col) =>
  (state.filters.find(([o, c]) => o === op && c === col) || [])[2];

// ── Registry contract ─────────────────────────────────────────────────────

describe("registry contract", () => {
  it("every registered pack validates cleanly", () => {
    for (const pack of PACKS) {
      expect(validatePack(pack), `pack ${pack.key}`).toEqual([]);
    }
  });

  it("provider keys are globally unique (they are dismissal keys)", () => {
    const keys = allProviderKeys();
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z_]+\.[a-z0-9_]+$/);
  });

  it("every pack panel key is a real Tangerine module key", () => {
    const canonical = new Set(TANGERINE_MODULES.map((m) => m.key));
    for (const k of panelKeys()) {
      expect(canonical.has(k), `panel key "${k}" not in TANGERINE_MODULES`).toBe(true);
    }
  });

  it("severity vocabulary is closed", () => {
    expect(isValidSeverity("action")).toBe(true);
    expect(isValidSeverity("urgent")).toBe(false);
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────

describe("permitsModule", () => {
  it("null permissions = legacy pass-through", () => {
    expect(permitsModule(null, "procurement")).toBe(true);
    expect(permitsModule(undefined, "procurement")).toBe(true);
  });
  it("Set permissions require <module>:read", () => {
    const perms = new Set(["procurement:read", "workflows:write"]);
    expect(permitsModule(perms, "procurement")).toBe(true);
    expect(permitsModule(perms, "workflows")).toBe(false);
    expect(permitsModule(perms, "finance_misc")).toBe(false);
  });
});

describe("filterDismissed / sortTodos", () => {
  it("drops dismissed keys only", () => {
    const items = [{ key: "a" }, { key: "b" }];
    expect(filterDismissed(items, new Set(["a"]))).toEqual([{ key: "b" }]);
    expect(filterDismissed(items, new Set())).toEqual(items);
  });
  it("orders action before warn before info, count desc within", () => {
    const out = sortTodos([
      { key: "i", severity: "info", count: 99 },
      { key: "w2", severity: "warn", count: 2 },
      { key: "a", severity: "action", count: 1 },
      { key: "w9", severity: "warn", count: 9 },
    ]);
    expect(out.map((x) => x.key)).toEqual(["a", "w9", "w2", "i"]);
  });
});

describe("reduceLatestByDomain", () => {
  it("keeps first (newest) row per domain", () => {
    const rows = [
      { domain: "ar", status: "success" },
      { domain: "ap", status: "error" },
      { domain: "ar", status: "error" },
    ];
    const out = reduceLatestByDomain(rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.domain === "ar").status).toBe("success");
  });
  it("tolerates empty/null", () => {
    expect(reduceLatestByDomain(null)).toEqual([]);
  });
});

describe("todayISO", () => {
  it("returns UTC calendar date", () => {
    expect(todayISO(new Date("2026-07-14T23:59:00Z"))).toBe("2026-07-14");
  });
});

// ── buildToday aggregator ─────────────────────────────────────────────────

const fixturePacks = [{
  key: "fx",
  label: "Fixture",
  module_keys: ["procurement", "workflows"],
  todos: [
    { key: "fx.ok", module_key: "procurement", run: async () => [{ key: "fx.ok", title: "T", count: 3, severity: "warn" }] },
    { key: "fx.gated", module_key: "workflows", run: async () => [{ key: "fx.gated", title: "G", count: 1, severity: "action" }] },
    { key: "fx.boom", module_key: "procurement", run: async () => { throw new Error("kaput"); } },
  ],
  processes: [
    { key: "fx.proc", module_key: "procurement", run: async () => [{ key: "fx.proc", label: "P", state: "ok" }] },
  ],
  suggestions: [
    { key: "fx.sugg", module_key: "procurement", derive: (agg) => (agg.todos.some((t) => t.key === "fx.ok") ? [{ key: "fx.sugg", text: "do it" }] : []) },
  ],
  panels: { receiving: {} },
}];

const insightsAdmin = (rows = []) => fakeAdmin((state) => {
  if (state.table === "ai_insights") return { data: rows };
  return {};
});

describe("buildToday", () => {
  it("merges providers, filters by RBAC, isolates failures", async () => {
    const ctx = {
      userId: "u1",
      permissions: new Set(["procurement:read"]), // NO workflows:read
      dismissedKeys: new Set(),
      packs: fixturePacks,
    };
    const out = await buildToday(insightsAdmin(), ctx);
    expect(out.todos.map((t) => t.key)).toEqual(["fx.ok"]);        // gated one filtered
    expect(out.todos[0].pack).toBe("fx");
    expect(out.processes).toHaveLength(1);
    expect(out.suggestions.map((s) => s.key)).toEqual(["fx.sugg"]);
    expect(out.errors).toHaveLength(1);                             // fx.boom isolated
    expect(out.errors[0]).toMatchObject({ provider: "fx.boom", error: "kaput" });
  });

  it("null permissions pass everything through", async () => {
    const ctx = { userId: null, permissions: null, dismissedKeys: new Set(), packs: fixturePacks };
    const out = await buildToday(insightsAdmin(), ctx);
    expect(out.todos.map((t) => t.key).sort()).toEqual(["fx.gated", "fx.ok"]);
  });

  it("applies dismissals to todos and suggestions", async () => {
    const ctx = {
      userId: "u1",
      permissions: null,
      dismissedKeys: new Set(["fx.ok", "fx.sugg"]),
      packs: fixturePacks,
    };
    const out = await buildToday(insightsAdmin(), ctx);
    expect(out.todos.map((t) => t.key)).toEqual(["fx.gated"]);
    expect(out.suggestions).toEqual([]);
  });

  it("RBAC-filters pack-attributed insights, passes legacy NULL pack rows", async () => {
    const rows = [
      { id: 1, pack_key: null, title: "legacy" },
      { id: 2, pack_key: "fx", title: "fixture insight" },
      { id: 3, pack_key: "unknown_pack", title: "orphan" },
    ];
    const seeing = await buildToday(insightsAdmin(rows), {
      permissions: new Set(["procurement:read"]), dismissedKeys: new Set(), packs: fixturePacks,
    });
    expect(seeing.insights.map((r) => r.id)).toEqual([1, 2, 3]);

    const blind = await buildToday(insightsAdmin(rows), {
      permissions: new Set(["analytics:read"]), dismissedKeys: new Set(), packs: fixturePacks,
    });
    expect(blind.insights.map((r) => r.id)).toEqual([1, 3]); // fx-attributed row hidden
  });
});

// ── Real packs against a canned DB ────────────────────────────────────────

describe("real packs run against canned counts", () => {
  const COUNTS = {
    approval_requests: (s) => (filterVal(s, "eq", "created_by_user_id") ? 2 : 5),
    factor_chargebacks: () => 7,
    close_periods: (s) => (s.filters.length === 0 ? 0 : 0),
    app_errors: () => 4,
    po_messages: () => 3,
    vendor_invoice_drafts: () => 1,
    ip_open_purchase_orders: (s) => (filterVal(s, "lt", "expected_date") ? 12 : 6),
    tanda_po_qc_inspections: () => 0,
    edi_messages: (s) => (filterVal(s, "gte", "attempts") !== undefined ? 0 : 2),
    // P28-1-3 packs
    sales_orders: () => 2,
    v_allocation_demand: (s) => {
      if (filterVal(s, "eq", "is_factored") !== undefined) return 9;      // factor gate
      if (filterVal(s, "lt", "requested_ship_date")) return 40;           // overdue
      return 15;                                                          // due ≤7d
    },
    ip_execution_batches: () => 1,
    v_style_scale_missing: () => 44,
    v_prepack_ppk_needed: () => 59,
    // P28-1-4 packs
    mfg_build_orders: () => 3,
    cases: (s) => (filterVal(s, "eq", "assignee_user_id") ? 2 : 5),   // mine vs unassigned
    notification_dispatches: () => 138,
  };
  const ROWS = {
    xoro_mirror_runs: [
      { domain: "ar", status: "complete", mirror_date: "2026-07-13", completed_at: "x" },
      { domain: "ap", status: "failed", errors: ["boom"], completed_at: "y" },
    ],
    ip_planning_runs: [{ id: "r1", name: "July run", status: "complete", created_at: "z" }],
    ai_insights: [],
  };
  const admin = fakeAdmin((state) => {
    if (state.table in ROWS) return { data: ROWS[state.table] };
    const fn = COUNTS[state.table];
    if (!fn) throw new Error(`unexpected table ${state.table}`);
    return { count: fn(state) };
  });

  it("produces a coherent Today payload with zero errors", async () => {
    const out = await buildToday(admin, {
      userId: "u1", permissions: null, dismissedKeys: new Set(), todayISO: "2026-07-14",
    });
    expect(out.errors).toEqual([]);

    const byKey = Object.fromEntries(out.todos.map((t) => [t.key, t]));
    expect(byKey["accounting.approvals_pending"].count).toBe(3);   // 5 pending - 2 mine
    expect(byKey["accounting.chargebacks_open"].count).toBe(7);
    expect(byKey["accounting.close_not_started"].severity).toBe("info");
    expect(byKey["accounting.cron_errors_24h"].count).toBe(4);
    expect(byKey["po.portal_replies_unread"].count).toBe(3);
    // Deep-links to the PO WIP Messages view, pre-filtered to unread replies.
    expect(byKey["po.portal_replies_unread"].href).toBe("/tanda?view=messages&unread=1");
    expect(byKey["po.three_way_exceptions"].count).toBe(1);
    expect(byKey["po.receipts_due_7d"].count).toBe(6);
    expect(byKey["po.receipts_overdue"].count).toBe(12);
    expect(byKey["po.qc_failed_open"]).toBeUndefined();            // zero → hidden

    // P28-1-3 packs
    expect(byKey["so.drafts_aging"].count).toBe(2);
    expect(byKey["so.ship_due_7d"].count).toBe(15);
    expect(byKey["so.ship_overdue"].count).toBe(40);
    expect(byKey["so.factor_not_submitted"].count).toBe(9);
    expect(byKey["planning.exec_batches_draft"].count).toBe(1);
    expect(byKey["planning.exec_batches_draft"].href).toBe("/planning");
    expect(byKey["master.scales_missing"].count).toBe(44);
    expect(byKey["master.ppk_matrix_needed"].count).toBe(59);

    // P28-1-4 packs — mine-vs-unassigned split works, personal items keyed on ctx.userId
    expect(byKey["mfg.builds_open"].count).toBe(3);
    expect(byKey["cases.mine_open"].count).toBe(2);
    expect(byKey["cases.unassigned_open"].count).toBe(5);
    expect(byKey["cases.notifications_unread"].count).toBe(138);

    const procs = Object.fromEntries(out.processes.map((p) => [p.key, p]));
    expect(procs["accounting.mirror.ar"].state).toBe("ok");
    expect(procs["accounting.mirror.ap"].state).toBe("error");
    expect(procs["po.edi_outbox"].state).toBe("running");          // 2 queued, 0 stuck
    expect(procs["planning.latest_run"].state).toBe("ok");

    // suggestions fired off the aggregate
    expect(out.suggestions.map((s) => s.key).sort()).toEqual([
      "accounting.suggest_close_adoption",
      "master.suggest_bulk_scale_assign",
      "po.suggest_chase_overdue",
      "so.suggest_auto_allocate",
    ]);

    // every emitted item uses the closed severity vocabulary
    for (const t of out.todos) expect(isValidSeverity(t.severity), t.key).toBe(true);

    // Today drill params — each wired to-do carries the filter its panel reads.
    expect(byKey["accounting.chargebacks_open"].drill).toEqual({ cb_disposition: "open" });
    expect(byKey["master.scales_missing"].drill).toEqual({ scale: "missing" });
    expect(byKey["master.ppk_matrix_needed"].drill).toEqual({ needed: "1" });
    expect(byKey["so.drafts_aging"].drill).toEqual({ status: "draft" });
    expect(byKey["mfg.builds_open"].drill).toEqual({ status: "open" });
    expect(byKey["cases.mine_open"].drill).toEqual({ assignee: "me", status: "open" });
    expect(byKey["cases.unassigned_open"].drill).toEqual({ assignee: "none", status: "open" });
    expect(byKey["cases.notifications_unread"].drill).toEqual({ unread: "1" });
    // Deferred / intentionally plain-open to-dos carry no drill.
    expect(byKey["po.receipts_overdue"].drill).toBeUndefined();
    expect(byKey["accounting.cron_errors_24h"].drill).toBeUndefined();
    expect(byKey["accounting.close_not_started"].drill).toBeUndefined();
  });

  it("close_open_prior carries a month drill = the earliest still-open prior period", async () => {
    // close_periods exists (total>0) with an open prior month; the provider adds
    // a drill preselecting the EARLIEST open prior period (YYYY-MM).
    const closeAdmin = fakeAdmin((state) => {
      if (state.table === "ai_insights") return { data: [] };
      if (state.table === "close_periods") {
        if (state.filters.length === 0) return { count: 5 };          // total rows
        if (state.opts && state.opts.head) return { count: 3 };       // openPrior count
        return { data: [{ period_month: "2025-11-01" }] };            // earliest select
      }
      return { count: 0, data: [] }; // every other pack stays quiet
    });
    const out = await buildToday(closeAdmin, {
      userId: "u1", permissions: null, dismissedKeys: new Set(), todayISO: "2026-07-14",
    });
    const hit = out.todos.find((t) => t.key === "accounting.close_open_prior");
    expect(hit).toBeTruthy();
    expect(hit.count).toBe(3);
    expect(hit.drill).toEqual({ month: "2025-11" });
  });

  it("personal items stay hidden without a resolvable user", async () => {
    const out = await buildToday(admin, {
      userId: null, permissions: null, dismissedKeys: new Set(), todayISO: "2026-07-14",
    });
    const keys = new Set(out.todos.map((t) => t.key));
    expect(keys.has("cases.mine_open")).toBe(false);
    expect(keys.has("cases.notifications_unread")).toBe(false);
    expect(keys.has("cases.unassigned_open")).toBe(true); // entity-wide item still shows
  });
});
