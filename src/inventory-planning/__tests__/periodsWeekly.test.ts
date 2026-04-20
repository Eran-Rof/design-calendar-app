import { describe, it, expect } from "vitest";
import { weekOf, weeksBetween, weekOffset, weeksDiff } from "../compute/periods";

describe("weekOf (ISO 8601 week)", () => {
  it("Monday anchors the week", () => {
    // 2026-04-20 is a Monday → period_code 2026-W17
    const w = weekOf("2026-04-20");
    expect(w.period_code).toBe("2026-W17");
    expect(w.week_start).toBe("2026-04-20");
    expect(w.week_end).toBe("2026-04-26");
  });
  it("a Sunday maps to its ISO week (ending that day)", () => {
    const w = weekOf("2026-04-26");
    expect(w.period_code).toBe("2026-W17");
    expect(w.week_start).toBe("2026-04-20");
  });
  it("handles year-boundary (Jan 1 2024 is a Monday → W01)", () => {
    const w = weekOf("2024-01-01");
    expect(w.period_code).toBe("2024-W01");
  });
  it("handles year-boundary (Jan 1 2023 is a Sunday → W52 of 2022)", () => {
    const w = weekOf("2023-01-01");
    expect(w.period_code).toBe("2022-W52");
  });
});

describe("weeksBetween", () => {
  it("inclusive", () => {
    const ws = weeksBetween("2026-04-20", "2026-05-17");
    expect(ws.map((w) => w.period_code)).toEqual(["2026-W17", "2026-W18", "2026-W19", "2026-W20"]);
  });
  it("[] when reversed", () => {
    expect(weeksBetween("2026-05-20", "2026-04-20")).toEqual([]);
  });
});

describe("weekOffset / weeksDiff", () => {
  it("weekOffset steps back n weeks", () => {
    expect(weekOffset("2026-04-20", 3).period_code).toBe("2026-W14");
  });
  it("weeksDiff counts inclusive mondays", () => {
    expect(weeksDiff("2026-04-06", "2026-04-20")).toBe(2);
  });
});
