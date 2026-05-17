// Pure helpers extracted from the two mini-calendars inside
// dashboardPanel.tsx (the "This Week" 8-day strip + the "Next 30 Days"
// month grid). No React, no state — safe to import from unit tests.
//
// The two calendars duplicated the day-name list, the date-strip
// builder, the per-month grid builder, and the tasks-by-due grouping.
// Pulled out here so the dashboard's render closure stops re-allocating
// these on every render AND so the math has a tested ground truth.

import type { Task } from "../../store/types";
import { toDateStr } from "../../utils/dates";

// Sun → Sat. Both calendars rendered their own copies of this; the
// second one even called it DAY_NAMES while the first called it
// DAY_NAMES_FULL — they were identical.
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// Build an 8-day strip starting at `start` (inclusive) at midnight.
// Used by the "This Week" mini-calendar.
export function buildDayStrip(start: Date, length = 8): Date[] {
  const base = new Date(start);
  base.setHours(0, 0, 0, 0);
  return Array.from({ length }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d;
  });
}

// Returns the calendar months (as {year, month}) touched by the
// inclusive range [start, end]. Used by the "Next 30 Days" calendar
// to know how many month grids to render.
export function buildMonthsInRange(start: Date, end: Date): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonthStart = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur <= endMonthStart) {
    months.push({ year: cur.getFullYear(), month: cur.getMonth() });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return months;
}

// Group tasks by their due-date string (YYYY-MM-DD). When the same
// task id appears more than once (e.g. it's in both dueThisWeek and
// the activeMeta.tasks slice), only the first occurrence is kept.
// Returns a plain object so JSON-style access stays cheap.
export function groupTasksByDueDate(tasksLists: Task[][]): Record<string, Task[]> {
  const out: Record<string, Task[]> = {};
  for (const list of tasksLists) {
    for (const t of list) {
      const bucket = out[t.due] ?? (out[t.due] = []);
      if (!bucket.find(x => x.id === t.id)) bucket.push(t);
    }
  }
  return out;
}

// Filter a task list to those due on `day`. Convenience wrapper over
// toDateStr — saves the calendar from re-stringifying the date by hand.
export function tasksOnDay(tasks: Task[], day: Date): Task[] {
  const ds = toDateStr(day);
  return tasks.filter(t => t.due === ds);
}

// True for Sunday + Saturday. The 30-day grid uses index-based check
// (di === 0 || di === 6), the week strip uses Date.getDay() — both
// produce the same bool but it's clearer to name it.
export function isWeekend(day: Date): boolean {
  const d = day.getDay();
  return d === 0 || d === 6;
}
