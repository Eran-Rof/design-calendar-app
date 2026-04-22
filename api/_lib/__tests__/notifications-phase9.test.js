import { describe, it, expect } from "vitest";
import {
  digestSubject, digestBody, dueSoonSubject,
  filterDigestInsights, filterDueSoonTasks,
} from "../notifications-phase9.js";

describe("digestSubject", () => {
  it("matches the spec shape", () => {
    expect(digestSubject(3)).toBe("Procurement insights: 3 new recommendations");
  });
});

describe("digestBody", () => {
  it("falls back to a placeholder when empty", () => {
    expect(digestBody([])).toMatch(/No new insights/);
  });
  it("renders bullet lines and truncates beyond 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ type: "risk_alert", title: `t${i}`, recommendation: "r" }));
    const out = digestBody(many);
    expect(out.split("\n").filter((l) => l.startsWith("•")).length).toBe(20);
    expect(out).toMatch(/…and 5 more/);
  });
});

describe("filterDigestInsights", () => {
  const now = new Date("2026-04-19T12:00:00Z");
  const rows = [
    { id: "a", type: "risk_alert",        status: "new",      generated_at: "2026-04-19T08:00:00Z" },
    { id: "b", type: "cost_saving",       status: "new",      generated_at: "2026-04-18T20:00:00Z" },
    { id: "c", type: "cost_saving",       status: "read",     generated_at: "2026-04-19T10:00:00Z" }, // not new
    { id: "d", type: "consolidation",     status: "new",      generated_at: "2026-04-19T10:00:00Z" }, // wrong type
    { id: "e", type: "risk_alert",        status: "new",      generated_at: "2026-04-17T00:00:00Z" }, // stale
  ];
  it("keeps only new risk_alert + cost_saving within the last 24h", () => {
    const out = filterDigestInsights(rows, { now, withinHours: 24 });
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("dueSoonSubject", () => {
  it("matches the spec shape", () => {
    expect(dueSoonSubject({ title: "Ship samples", due_date: "2026-04-21" }))
      .toBe("Task due soon: Ship samples — due 2026-04-21");
  });
});

describe("filterDueSoonTasks", () => {
  const now = new Date("2026-04-19T12:00:00Z");
  const tasks = [
    { id: "1", title: "today",      due_date: "2026-04-19", status: "open" },
    { id: "2", title: "tomorrow",   due_date: "2026-04-20", status: "in_progress" },
    { id: "3", title: "d+2",        due_date: "2026-04-21", status: "open" },
    { id: "4", title: "d+3",        due_date: "2026-04-22", status: "open" }, // outside window
    { id: "5", title: "done",       due_date: "2026-04-20", status: "complete" }, // completed, skip
    { id: "6", title: "cancelled",  due_date: "2026-04-20", status: "cancelled" }, // cancelled, skip
    { id: "7", title: "past",       due_date: "2026-04-18", status: "open" }, // past, skip
    { id: "8", title: "no-date",    due_date: null,          status: "open" },
  ];
  it("keeps tasks due within [today, today+2d], excluding complete/cancelled/past/undated", () => {
    const out = filterDueSoonTasks(tasks, { now, withinDays: 2 });
    expect(out.map((t) => t.id).sort()).toEqual(["1", "2", "3"]);
  });
});
