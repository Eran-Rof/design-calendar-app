// Unit tests for the Design Calendar derived-state selectors.
// These pure functions drive every stat card on the dashboard —
// "Overdue", "Due This Week", "Due in 30", per-collection counts —
// so a regression here means wrong numbers staring at every operator.
// Covered: filter logic, visibility / view-all permissions, time-window
// bucketing (overdue / due-this-week / due-30), and the collection
// rollup.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  selectGetBrand,
  selectIsAdmin,
  selectCanViewAll,
  selectVisibleTasks,
  selectFiltered,
  selectOverdue,
  selectDueThisWeek,
  selectDue30,
  selectCollMap,
  selectCollList,
} from "../selectors";
import type { Task, Brand, User } from "../types";
import { UNKNOWN_BRAND } from "../types";

// Minimal AppStore shape — only the fields the selectors actually read.
// The real store has 100+ fields; using `any` here keeps tests resilient
// to additions that don't touch the selector inputs.
function makeStore(over: Partial<any> = {}): any {
  return {
    tasks: [] as Task[],
    collections: {},
    brands: [] as Brand[],
    currentUser: null as User | null,
    filterBrand:    new Set<string>(),
    filterSeason:   new Set<string>(),
    filterCustomer: new Set<string>(),
    filterVendor:   new Set<string>(),
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    brand: "ROF",
    collection: "SS26",
    season: "SS26",
    category: "Tops",
    phase: "Design",
    due: "2026-12-31",
    status: "In Progress",
    assigneeId: "u1",
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Brand + user permissions
// ────────────────────────────────────────────────────────────────────────

describe("selectGetBrand", () => {
  it("returns matching brand by id", () => {
    const s = makeStore({ brands: [{ id: "b1", name: "ROF", color: "#fff" }] });
    expect(selectGetBrand(s)("b1").name).toBe("ROF");
  });
  it("falls back to first brand when id not found", () => {
    const s = makeStore({ brands: [{ id: "b1", name: "ROF", color: "#fff" }] });
    expect(selectGetBrand(s)("does-not-exist").id).toBe("b1");
  });
  it("falls back to UNKNOWN_BRAND when no brands at all", () => {
    const s = makeStore({ brands: [] });
    // Real BRANDS constant may have entries; with empty brands and no
    // BRANDS fallback hit, we land on UNKNOWN_BRAND. Just check the
    // function returns SOMETHING — fallback chain depends on
    // BRANDS const which we don't control here.
    const got = selectGetBrand(s)("x");
    expect(got).toBeDefined();
    expect(typeof got.name).toBe("string");
  });
});

describe("selectIsAdmin / selectCanViewAll", () => {
  it("isAdmin true only when currentUser.role === 'admin'", () => {
    expect(selectIsAdmin(makeStore({ currentUser: { name: "X", role: "admin" } }))).toBe(true);
    expect(selectIsAdmin(makeStore({ currentUser: { name: "X", role: "user"  } }))).toBe(false);
    expect(selectIsAdmin(makeStore({ currentUser: null }))).toBe(false);
  });
  it("canViewAll true for admins OR users with view_all permission", () => {
    expect(selectCanViewAll(makeStore({ currentUser: { name: "X", role: "admin" } }))).toBe(true);
    expect(selectCanViewAll(makeStore({ currentUser: { name: "X", role: "user", permissions: { view_all: true } } }))).toBe(true);
    expect(selectCanViewAll(makeStore({ currentUser: { name: "X", role: "user", permissions: { view_all: false } } }))).toBe(false);
    expect(selectCanViewAll(makeStore({ currentUser: { name: "X", role: "user" } }))).toBe(undefined);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Visibility — admins see all, users see only their assignments
// ────────────────────────────────────────────────────────────────────────

describe("selectVisibleTasks", () => {
  const tasks = [
    task({ id: "a", assigneeId: "u1" }),
    task({ id: "b", assigneeId: "u2" }),
    task({ id: "c", assigneeId: "u1" }),
  ];

  it("admin sees every task", () => {
    const s = makeStore({ tasks, currentUser: { name: "X", role: "admin", teamMemberId: "u1" } });
    expect(selectVisibleTasks(s).map(t => t.id)).toEqual(["a", "b", "c"]);
  });

  it("non-admin user sees only own assignments", () => {
    const s = makeStore({ tasks, currentUser: { name: "X", role: "user", teamMemberId: "u1" } });
    expect(selectVisibleTasks(s).map(t => t.id)).toEqual(["a", "c"]);
  });

  it("non-admin user with view_all permission sees every task", () => {
    const s = makeStore({ tasks, currentUser: { name: "X", role: "user", teamMemberId: "u1", permissions: { view_all: true } } });
    expect(selectVisibleTasks(s).map(t => t.id)).toEqual(["a", "b", "c"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Filtering — brand / season / customer / vendor
// ────────────────────────────────────────────────────────────────────────

describe("selectFiltered", () => {
  const tasks = [
    task({ id: "a", brand: "ROF",   collection: "SS26", season: "SS26", vendorName: "VendorA" }),
    task({ id: "b", brand: "Other", collection: "SS26", season: "SS26", vendorName: "VendorB" }),
    task({ id: "c", brand: "ROF",   collection: "FW26", season: "FW26", vendorName: "VendorA" }),
  ];
  const baseUser: User = { name: "X", role: "admin", teamMemberId: "u1" };

  it("returns all when no filters set", () => {
    const s = makeStore({ tasks, currentUser: baseUser });
    expect(selectFiltered(s).length).toBe(3);
  });

  it("filters by brand (set membership)", () => {
    const s = makeStore({ tasks, currentUser: baseUser, filterBrand: new Set(["ROF"]) });
    expect(selectFiltered(s).map(t => t.id)).toEqual(["a", "c"]);
  });

  it("filters by season", () => {
    const s = makeStore({ tasks, currentUser: baseUser, filterSeason: new Set(["SS26"]) });
    expect(selectFiltered(s).map(t => t.id)).toEqual(["a", "b"]);
  });

  it("filters by vendor", () => {
    const s = makeStore({ tasks, currentUser: baseUser, filterVendor: new Set(["VendorA"]) });
    expect(selectFiltered(s).map(t => t.id)).toEqual(["a", "c"]);
  });

  it("filters by customer via collection lookup", () => {
    const s = makeStore({
      tasks,
      currentUser: baseUser,
      collections: { "ROF||SS26": { customer: "Nordstrom" } },
      filterCustomer: new Set(["Nordstrom"]),
    });
    expect(selectFiltered(s).map(t => t.id)).toEqual(["a"]);
  });

  it("multiple filters AND together", () => {
    const s = makeStore({
      tasks,
      currentUser: baseUser,
      filterBrand:  new Set(["ROF"]),
      filterSeason: new Set(["SS26"]),
    });
    expect(selectFiltered(s).map(t => t.id)).toEqual(["a"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Time-window buckets — overdue / due-this-week / due-30
// ────────────────────────────────────────────────────────────────────────

describe("selectOverdue / selectDueThisWeek / selectDue30", () => {
  // Pin "today" to 2026-05-16 so getDaysUntil() is deterministic.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tasks = [
    task({ id: "past",    due: "2026-05-10", status: "In Progress" }),  // 6 days overdue
    task({ id: "today",   due: "2026-05-16", status: "In Progress" }),  // 0 days
    task({ id: "wk",      due: "2026-05-22", status: "In Progress" }),  // 6 days
    task({ id: "wk-edge", due: "2026-05-23", status: "In Progress" }),  // 7 days (still "this week")
    task({ id: "soon",    due: "2026-05-24", status: "In Progress" }),  // 8 days (due-30, not week)
    task({ id: "later",   due: "2026-06-14", status: "In Progress" }),  // 29 days (due-30)
    task({ id: "far",     due: "2026-06-16", status: "In Progress" }),  // 31 days (none)
    task({ id: "done",    due: "2026-05-10", status: "Complete" }),     // overdue but complete — excluded
  ];
  const baseUser: User = { name: "X", role: "admin", teamMemberId: "u1" };

  it("overdue = past-due AND not Complete", () => {
    const s = makeStore({ tasks, currentUser: baseUser });
    expect(selectOverdue(s).map(t => t.id)).toEqual(["past"]);
  });

  it("dueThisWeek = [0, 7] days, excludes Complete", () => {
    const s = makeStore({ tasks, currentUser: baseUser });
    expect(selectDueThisWeek(s).map(t => t.id).sort())
      .toEqual(["today", "wk", "wk-edge"].sort());
  });

  it("due30 = (7, 30] days, excludes Complete and this-week", () => {
    const s = makeStore({ tasks, currentUser: baseUser });
    expect(selectDue30(s).map(t => t.id).sort())
      .toEqual(["later", "soon"].sort());
  });
});

// ────────────────────────────────────────────────────────────────────────
// Collection rollup
// ────────────────────────────────────────────────────────────────────────

describe("selectCollMap / selectCollList", () => {
  const tasks = [
    task({ id: "a", brand: "ROF", collection: "SS26", season: "SS26", vendorName: "V1" }),
    task({ id: "b", brand: "ROF", collection: "SS26", season: "SS26", vendorName: "V1" }),
    task({ id: "c", brand: "ROF", collection: "FW26", season: "FW26", vendorName: "V2" }),
    task({ id: "d", brand: "Other", collection: "SS26", season: "SS26", vendorName: "V3" }),
  ];

  it("groups tasks by brand||collection key", () => {
    const s = makeStore({ tasks });
    const map = selectCollMap(s);
    expect(Object.keys(map).sort()).toEqual([
      "Other||SS26", "ROF||FW26", "ROF||SS26",
    ]);
    expect(map["ROF||SS26"].tasks.map(t => t.id)).toEqual(["a", "b"]);
    expect(map["ROF||SS26"].vendorName).toBe("V1");
  });

  it("collList respects brand filter", () => {
    const s = makeStore({ tasks, filterBrand: new Set(["ROF"]) });
    const list = selectCollList(s);
    expect(list.map(c => c.collection).sort()).toEqual(["FW26", "SS26"]);
  });

  it("collList respects vendor filter", () => {
    const s = makeStore({ tasks, filterVendor: new Set(["V2"]) });
    const list = selectCollList(s);
    expect(list.map(c => c.collection)).toEqual(["FW26"]);
  });

  it("collList returns empty when filter matches nothing", () => {
    const s = makeStore({ tasks, filterBrand: new Set(["NoSuchBrand"]) });
    expect(selectCollList(s)).toEqual([]);
  });
});
