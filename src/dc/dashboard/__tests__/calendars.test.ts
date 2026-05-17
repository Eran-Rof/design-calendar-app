// Unit tests for the mini-calendar pure helpers.
// Covers: day-strip length + start-at-midnight invariant,
// month-range builder across year/quarter boundaries,
// tasks-by-due grouping with cross-list dedup, weekend detection.

import { describe, it, expect } from "vitest";
import {
  DAY_NAMES,
  buildDayStrip,
  buildMonthsInRange,
  groupTasksByDueDate,
  tasksOnDay,
  isWeekend,
} from "../calendars";
import type { Task } from "../../../store/types";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1", brand: "ROF", collection: "SS26", season: "SS26",
    category: "Tops", phase: "Design", due: "2026-05-17", status: "In Progress",
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────

describe("DAY_NAMES", () => {
  it("is Sunday-first", () => {
    expect(DAY_NAMES[0]).toBe("Sun");
    expect(DAY_NAMES[6]).toBe("Sat");
    expect(DAY_NAMES.length).toBe(7);
  });
});

describe("buildDayStrip", () => {
  it("returns N consecutive days from the start", () => {
    const strip = buildDayStrip(new Date("2026-05-17T15:00:00"), 8);
    expect(strip.length).toBe(8);
    // Each day is one calendar day after the previous one.
    for (let i = 1; i < strip.length; i++) {
      const delta = strip[i].getTime() - strip[i - 1].getTime();
      expect(delta).toBe(24 * 60 * 60 * 1000);
    }
  });
  it("snaps start to midnight (hours/minutes/seconds zeroed)", () => {
    const strip = buildDayStrip(new Date("2026-05-17T15:30:42"), 1);
    expect(strip[0].getHours()).toBe(0);
    expect(strip[0].getMinutes()).toBe(0);
    expect(strip[0].getSeconds()).toBe(0);
  });
  it("defaults to length 8 (matches the week-strip caller)", () => {
    expect(buildDayStrip(new Date("2026-05-17")).length).toBe(8);
  });
  it("does not mutate the input Date", () => {
    const start = new Date("2026-05-17T15:30:00");
    const startMs = start.getTime();
    buildDayStrip(start, 5);
    expect(start.getTime()).toBe(startMs);
  });
});

describe("buildMonthsInRange", () => {
  it("returns one month when start + end are in the same month", () => {
    const months = buildMonthsInRange(new Date(2026, 4, 1), new Date(2026, 4, 30));
    expect(months).toEqual([{ year: 2026, month: 4 }]);
  });
  it("returns sequential months when range spans 2 months", () => {
    const months = buildMonthsInRange(new Date(2026, 4, 20), new Date(2026, 5, 5));
    expect(months).toEqual([
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
    ]);
  });
  it("spans year boundary correctly", () => {
    const months = buildMonthsInRange(new Date(2026, 11, 20), new Date(2027, 0, 10));
    expect(months).toEqual([
      { year: 2026, month: 11 },
      { year: 2027, month: 0 },
    ]);
  });
  it("returns 3 months when range starts late + ends early next-next month", () => {
    const months = buildMonthsInRange(new Date(2026, 0, 31), new Date(2026, 2, 1));
    expect(months).toEqual([
      { year: 2026, month: 0 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ]);
  });
});

describe("groupTasksByDueDate", () => {
  it("groups by due-date string", () => {
    const out = groupTasksByDueDate([[
      task({ id: "a", due: "2026-05-17" }),
      task({ id: "b", due: "2026-05-17" }),
      task({ id: "c", due: "2026-05-18" }),
    ]]);
    expect(Object.keys(out).sort()).toEqual(["2026-05-17", "2026-05-18"]);
    expect(out["2026-05-17"].length).toBe(2);
    expect(out["2026-05-18"].length).toBe(1);
  });
  it("dedupes across multiple input lists by task id", () => {
    const out = groupTasksByDueDate([
      [task({ id: "a", due: "2026-05-17" })],
      [task({ id: "a", due: "2026-05-17" }), task({ id: "b", due: "2026-05-17" })],
    ]);
    expect(out["2026-05-17"].length).toBe(2);
    expect(out["2026-05-17"].map(t => t.id).sort()).toEqual(["a", "b"]);
  });
  it("returns empty object for empty input", () => {
    expect(groupTasksByDueDate([])).toEqual({});
    expect(groupTasksByDueDate([[], []])).toEqual({});
  });
});

describe("tasksOnDay", () => {
  it("returns tasks whose due matches the day's YYYY-MM-DD", () => {
    const tasks = [
      task({ id: "a", due: "2026-05-17" }),
      task({ id: "b", due: "2026-05-18" }),
    ];
    const day = new Date(2026, 4, 17);
    expect(tasksOnDay(tasks, day).map(t => t.id)).toEqual(["a"]);
  });
  it("returns [] when no tasks match", () => {
    expect(tasksOnDay([task({ due: "2026-05-17" })], new Date(2026, 4, 18))).toEqual([]);
  });
});

describe("isWeekend", () => {
  it("true on Sunday + Saturday", () => {
    expect(isWeekend(new Date(2026, 4, 17))).toBe(true); // 2026-05-17 is a Sunday
    expect(isWeekend(new Date(2026, 4, 16))).toBe(true); // Saturday
  });
  it("false on Mon–Fri", () => {
    for (let d = 18; d <= 22; d++) {
      // 2026-05-18 = Mon ... 2026-05-22 = Fri
      expect(isWeekend(new Date(2026, 4, d))).toBe(false);
    }
  });
});
