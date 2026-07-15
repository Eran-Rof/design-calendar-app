// P28 — morning-brief staleness guard: a cached brief must not contradict the
// live process cards. processStatesDiverged() flags a cached brief for
// regeneration ONLY when a process STATE flipped (ok/running/warn/error), never
// on count drift.

import { describe, it, expect } from "vitest";
import { processStatesDiverged } from "../../../_handlers/internal/assistant/brief.js";

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
