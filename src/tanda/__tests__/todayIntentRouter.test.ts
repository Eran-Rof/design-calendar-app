// P28 — Today intent-router resolver tests. Pure; no DOM.

import { describe, it, expect } from "vitest";
import { resolveIntent, expandIntent, normalizeIntent, type IntentTodo, type IntentSuggestion } from "../todayIntentRouter";
import { MODULES } from "../../erp/modules";

const modules = MODULES.map((m) => ({ key: m.key, label: m.label, group: m.group }));

const todos: IntentTodo[] = [
  { key: "po.receipts_overdue", title: "PO lines past expected receipt", detail: "Open quantity behind us", count: 12, severity: "warn", panel: "receiving", pack: "po" },
  { key: "po.three_way_exceptions", title: "3-way match exceptions", detail: "Vendor invoices out of tolerance", count: 3, severity: "action", panel: "three_way_match", pack: "po" },
  { key: "cases_inbox.open_cases", title: "Open cases", detail: "Customer service tickets", count: 5, severity: "info", panel: "cases", pack: "cases_inbox" },
];
const suggestions: IntentSuggestion[] = [];

describe("normalizeIntent / expandIntent", () => {
  it("strips filler + punctuation", () => {
    expect(normalizeIntent("work on the month close!")).toEqual(["month", "close"]);
    expect(normalizeIntent("take me to pos flagged here")).toEqual(["pos"]);
    expect(normalizeIntent("")).toEqual([]);
  });
  it("expands aliases into id + word hints", () => {
    const { ids, words } = expandIntent("month close");
    expect(ids.has("month_end_close")).toBe(true);
    expect(words.has("end")).toBe(true);
  });
});

describe("resolveIntent", () => {
  it("routes 'work on month close' to the Month-End Close module", () => {
    const r = resolveIntent("work on month close", { todos, suggestions, modules });
    expect(r.kind).toBe("module");
    expect(r.module?.key).toBe("month_end_close");
  });

  it("prefers a live PO to-do over the bare Procurement module for 'pos flagged here'", () => {
    const r = resolveIntent("work on pos flagged here", { todos, suggestions, modules });
    expect(r.kind).toBe("todo");
    expect(r.todo?.key.startsWith("po.")).toBe(true);
    // highest-severity matching to-do wins (action > warn)
    expect(r.todo?.key).toBe("po.three_way_exceptions");
  });

  it("routes 'chargebacks' to the Chargebacks module", () => {
    const r = resolveIntent("chargebacks", { todos, suggestions, modules });
    expect(r.module?.key || r.todo?.key).toBe("chargebacks");
    expect(r.kind).toBe("module");
  });

  it("returns 'none' with alternatives for garbage", () => {
    const r = resolveIntent("asdfg qwerty zzzxcv", { todos, suggestions, modules });
    expect(r.kind).toBe("none");
    expect(r.alternatives.length).toBeGreaterThan(0);
  });

  it("returns 'none' for empty input", () => {
    const r = resolveIntent("   ", { todos, suggestions, modules });
    expect(r.kind).toBe("none");
  });

  it("does not blow up with no data", () => {
    const r = resolveIntent("chargebacks", {});
    expect(r.kind).toBe("none");
  });
});
