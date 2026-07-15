// P28 — morning-brief staleness guard: a cached brief must not contradict the
// live process cards. processStatesDiverged() flags a cached brief for
// regeneration ONLY when a process STATE flipped (ok/running/warn/error), never
// on count drift.

import { describe, it, expect } from "vitest";
import {
  processStatesDiverged,
  aggregatesDiverged,
  computeBriefProgress,
  buildBriefPrompt,
} from "../../../_handlers/internal/assistant/brief.js";

describe("processStatesDiverged", () => {
  const cached = [
    { key: "xoro.mirror_sales", label: "Sales mirror", state: "error", detail: "3 failed", count: 3 },
    { key: "xoro.mirror_inv", label: "Inventory mirror", state: "ok", detail: "up to date" },
  ];

  it("false when states are identical", () => {
    const live = [
      { key: "xoro.mirror_sales", label: "Sales mirror", state: "error", detail: "still failing" },
      { key: "xoro.mirror_inv", label: "Inventory mirror", state: "ok" },
    ];
    expect(processStatesDiverged(cached, live)).toBe(false);
  });

  it("true when a mirror flips error -> ok", () => {
    const live = [
      { key: "xoro.mirror_sales", label: "Sales mirror", state: "ok" },
      { key: "xoro.mirror_inv", label: "Inventory mirror", state: "ok" },
    ];
    expect(processStatesDiverged(cached, live)).toBe(true);
  });

  it("false for a count-only change (state unchanged)", () => {
    const live = [
      { key: "xoro.mirror_sales", label: "Sales mirror", state: "error", detail: "9 failed", count: 9 },
      { key: "xoro.mirror_inv", label: "Inventory mirror", state: "ok" },
    ];
    expect(processStatesDiverged(cached, live)).toBe(false);
  });

  it("true when a process is added", () => {
    const live = [
      ...cached,
      { key: "xoro.mirror_ap", label: "AP mirror", state: "ok" },
    ];
    expect(processStatesDiverged(cached, live)).toBe(true);
  });

  it("true when a process is removed", () => {
    const live = [{ key: "xoro.mirror_sales", label: "Sales mirror", state: "error" }];
    expect(processStatesDiverged(cached, live)).toBe(true);
  });

  it("tolerates missing / non-array inputs", () => {
    expect(processStatesDiverged(undefined, undefined)).toBe(false);
    expect(processStatesDiverged(null, [])).toBe(false);
    expect(processStatesDiverged([{ key: "a", state: "ok" }], null)).toBe(true);
  });
});

describe("aggregatesDiverged", () => {
  const base = {
    todos: [
      { key: "vendor_replies", title: "Vendor replies unread", count: 4, severity: "warn" },
      { key: "approvals", title: "Approvals waiting", count: 2, severity: "action" },
    ],
    processes: [
      { key: "xoro.mirror_sales", label: "Sales mirror", state: "error" },
      { key: "xoro.mirror_inv", label: "Inventory mirror", state: "ok" },
    ],
    suggestions: [{ key: "overdue_po", text: "Update stale expected dates" }],
    partial: false,
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  it("false when identical", () => {
    expect(aggregatesDiverged(base, clone(base))).toBe(false);
  });

  it("true when a to-do key is completed (gone from live)", () => {
    const live = clone(base);
    live.todos = live.todos.filter((t) => t.key !== "vendor_replies");
    expect(aggregatesDiverged(base, live)).toBe(true);
  });

  it("true when a new to-do key appears in live", () => {
    const live = clone(base);
    live.todos.push({ key: "qc_fail", title: "Failed QC", count: 1, severity: "action" });
    expect(aggregatesDiverged(base, live)).toBe(true);
  });

  it("FALSE for count-only drift on a surviving to-do", () => {
    const live = clone(base);
    live.todos[0].count = 2; // 4 -> 2, same key set
    live.todos[0].detail = "fewer now";
    expect(aggregatesDiverged(base, live)).toBe(false);
  });

  it("true when a suggestion key changes", () => {
    const live = clone(base);
    live.suggestions = [{ key: "close_period", text: "Close last month" }];
    expect(aggregatesDiverged(base, live)).toBe(true);
  });

  it("true when a process state flips", () => {
    const live = clone(base);
    live.processes[0].state = "ok"; // error -> ok
    expect(aggregatesDiverged(base, live)).toBe(true);
  });

  it("tolerates missing / non-object inputs", () => {
    expect(aggregatesDiverged(undefined, undefined)).toBe(false);
    expect(aggregatesDiverged(null, {})).toBe(false);
    expect(aggregatesDiverged({ todos: [{ key: "a" }] }, {})).toBe(true);
  });
});

describe("computeBriefProgress", () => {
  const cached = {
    todos: [
      { key: "vendor_replies", title: "Vendor replies unread", count: 4, severity: "warn" },
      { key: "approvals", title: "Approvals waiting", count: 3, severity: "action" },
    ],
  };

  it("detects completed items (in cached, gone from live)", () => {
    const live = { todos: [{ key: "approvals", title: "Approvals waiting", count: 3 }] };
    const p = computeBriefProgress(cached, live);
    expect(p.completed).toEqual([{ key: "vendor_replies", title: "Vendor replies unread", count: 4 }]);
    expect(p.appeared).toEqual([]);
  });

  it("detects appeared items (new in live)", () => {
    const live = {
      todos: [
        ...cached.todos,
        { key: "qc_fail", title: "Failed QC", count: 2, severity: "action" },
      ],
    };
    const p = computeBriefProgress(cached, live);
    expect(p.completed).toEqual([]);
    expect(p.appeared).toEqual([{ key: "qc_fail", title: "Failed QC", count: 2, severity: "action" }]);
  });

  it("detects reduced items (lower count, same key)", () => {
    const live = {
      todos: [
        { key: "vendor_replies", title: "Vendor replies unread", count: 1 },
        { key: "approvals", title: "Approvals waiting", count: 3 },
      ],
    };
    const p = computeBriefProgress(cached, live);
    expect(p.reduced).toEqual([{ key: "vendor_replies", title: "Vendor replies unread", from: 4, to: 1 }]);
    expect(p.completed).toEqual([]);
  });

  it("empty when identical", () => {
    const p = computeBriefProgress(cached, JSON.parse(JSON.stringify(cached)));
    expect(p).toEqual({ completed: [], appeared: [], reduced: [] });
  });

  it("tolerant of missing / empty arrays", () => {
    expect(computeBriefProgress(undefined, undefined)).toEqual({ completed: [], appeared: [], reduced: [] });
    expect(computeBriefProgress(null, { todos: [] })).toEqual({ completed: [], appeared: [], reduced: [] });
    const p = computeBriefProgress({ todos: [{ key: "a", title: "A", count: 1 }] }, {});
    expect(p.completed).toEqual([{ key: "a", title: "A", count: 1 }]);
  });
});

describe("buildBriefPrompt", () => {
  const aggregate = { todos: [{ key: "approvals", title: "Approvals", count: 2 }], processes: [], suggestions: [], partial: false };

  it("without progress matches the prior (no-acknowledgment) behavior", () => {
    const prompt = buildBriefPrompt(aggregate, "Eran", "2026-07-15");
    expect(prompt).toContain("2026-07-15");
    expect(prompt).toContain("named Eran");
    expect(prompt).toContain("NEVER invent");
    expect(prompt).toContain("first read of the day");
    expect(prompt).not.toContain("PROGRESS:");
    expect(prompt).not.toContain("acknowledgment");
  });

  it("with completed progress instructs acknowledgment + what-next and still forbids fabrication", () => {
    const progress = { completed: [{ key: "vendor_replies", title: "Vendor replies unread", count: 4 }], appeared: [], reduced: [] };
    const prompt = buildBriefPrompt(aggregate, "Eran", "2026-07-15", progress);
    expect(prompt).toMatch(/acknowledgment/i);
    expect(prompt).toMatch(/what do you want to work on next/i);
    expect(prompt).toContain("PROGRESS:");
    expect(prompt).toContain("vendor_replies");
    expect(prompt).toMatch(/NEVER invent/);
  });

  it("empty completed list behaves like no progress", () => {
    const progress = { completed: [], appeared: [], reduced: [] };
    const prompt = buildBriefPrompt(aggregate, null, "2026-07-15", progress);
    expect(prompt).not.toContain("PROGRESS:");
    expect(prompt).toContain("first read of the day");
  });
});
