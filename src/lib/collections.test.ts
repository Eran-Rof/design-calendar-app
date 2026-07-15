import { describe, it, expect } from "vitest";
import {
  daysBetween,
  daysPastDue,
  ageBucket,
  promiseState,
  isPromiseBroken,
  summarizePromises,
  rollupBuckets,
  fmtCents,
  fmtDateUS,
  BUCKET_ORDER,
  type PromiseRow,
} from "./collections";

describe("aging", () => {
  it("computes whole days past due", () => {
    expect(daysBetween("2026-07-01", "2026-07-14")).toBe(13);
    expect(daysPastDue("2026-07-20", "2026-07-14")).toBe(-6); // not yet due
    expect(daysPastDue("2026-07-14", "2026-07-14")).toBe(0);
  });

  it("buckets on the SQL boundaries (<=0/30/60/90/120)", () => {
    expect(ageBucket(-5)).toBe("current");
    expect(ageBucket(0)).toBe("current");
    expect(ageBucket(1)).toBe("1-30");
    expect(ageBucket(30)).toBe("1-30");
    expect(ageBucket(31)).toBe("31-60");
    expect(ageBucket(60)).toBe("31-60");
    expect(ageBucket(61)).toBe("61-90");
    expect(ageBucket(90)).toBe("61-90");
    expect(ageBucket(91)).toBe("91-120");
    expect(ageBucket(120)).toBe("91-120");
    expect(ageBucket(121)).toBe("120+");
    expect(ageBucket(999)).toBe("120+");
  });

  it("has six buckets in age order", () => {
    expect(BUCKET_ORDER).toEqual(["current", "1-30", "31-60", "61-90", "91-120", "120+"]);
  });
});

describe("promise classification", () => {
  it("classifies upcoming / due today / broken", () => {
    expect(promiseState("2026-07-20", "2026-07-14")).toBe("upcoming");
    expect(promiseState("2026-07-14", "2026-07-14")).toBe("due_today");
    expect(promiseState("2026-07-10", "2026-07-14")).toBe("broken");
    expect(isPromiseBroken("2026-07-10", "2026-07-14")).toBe(true);
    expect(isPromiseBroken("2026-07-14", "2026-07-14")).toBe(false);
  });
});

describe("summarizePromises", () => {
  const rows: PromiseRow[] = [
    { promise_amount_cents: 100_00, promise_date: "2026-07-20", is_latest: true, promise_state: "upcoming" },
    { promise_amount_cents: 50_00, promise_date: "2026-07-14", is_latest: true, promise_state: "due_today" },
    { promise_amount_cents: 300_00, promise_date: "2026-07-01", is_latest: true, promise_state: "broken" },
    // superseded old promise — must NOT count:
    { promise_amount_cents: 999_00, promise_date: "2026-06-01", is_latest: false, promise_state: "broken" },
  ];

  it("sums latest promises by state and ignores superseded ones", () => {
    const s = summarizePromises(rows);
    expect(s.promisedCents).toBe(150_00); // upcoming + due_today
    expect(s.promisedCount).toBe(2);
    expect(s.brokenCents).toBe(300_00);
    expect(s.brokenCount).toBe(1);
  });

  it("derives state from date when promise_state absent", () => {
    const s = summarizePromises(
      [{ promise_amount_cents: 200_00, promise_date: "2026-07-01", is_latest: true }],
      "2026-07-14",
    );
    expect(s.brokenCents).toBe(200_00);
    expect(s.promisedCents).toBe(0);
  });
});

describe("rollupBuckets", () => {
  it("sums open by bucket and always returns all six", () => {
    const acc = rollupBuckets([
      { age_bucket: "1-30", open_cents: 100 },
      { age_bucket: "1-30", open_cents: 50 },
      { age_bucket: "120+", open_cents: 900 },
      { age_bucket: "bogus", open_cents: 12 }, // ignored
    ]);
    expect(acc["1-30"]).toBe(150);
    expect(acc["120+"]).toBe(900);
    expect(acc.current).toBe(0);
    expect(Object.keys(acc).length).toBe(6);
  });
});

describe("formatting", () => {
  it("formats cents as USD with thousands + 2dp", () => {
    expect(fmtCents(151585057)).toBe("$1,515,850.57");
    expect(fmtCents(0)).toBe("—");
    expect(fmtCents(-2500)).toBe("-$25.00");
  });

  it("formats ISO dates as MM/DD/YYYY", () => {
    expect(fmtDateUS("2026-07-14")).toBe("07/14/2026");
    expect(fmtDateUS(null)).toBe("—");
  });
});
