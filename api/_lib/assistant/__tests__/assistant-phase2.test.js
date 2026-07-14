// P28-2 — assistant-stage tests: shared context shaping, brief prompt,
// tool wiring (open_panel enum mirrors the registry), per-app AI caps.

import { describe, it, expect } from "vitest";
import { aggregateForModel, isUuid } from "../context.js";
import { panelKeys } from "../registry.js";
import { buildBriefPrompt } from "../../../_handlers/internal/assistant/brief.js";
import { TOOLS } from "../../ai/tool-defs.js";
import { TOOL_EXECUTORS } from "../../ai/executors.js";
import {
  TERMINAL_TOOLS, maxTokensForApp, maxIterationsForApp, MAX_TOKENS, MAX_TOOL_ITERATIONS,
} from "../../ai/constants.js";

describe("aggregateForModel", () => {
  it("compacts the payload to citeable facts only", () => {
    const out = aggregateForModel({
      todos: [{ key: "a.b", title: "T", count: 3, severity: "warn", detail: "d", panel: "cases", pack: "x", module_key: "m" }],
      processes: [{ key: "p.q", label: "P", state: "ok", pack: "x" }],
      suggestions: [{ key: "s.t", text: "do it", pack: "x" }],
      insights: [{ id: 1 }],
      errors: [{ pack: "x" }],
    });
    expect(out.todos).toEqual([{ key: "a.b", title: "T", count: 3, severity: "warn", detail: "d", panel: "cases" }]);
    expect(out.processes).toEqual([{ key: "p.q", label: "P", state: "ok", detail: null }]);
    expect(out.suggestions).toEqual([{ key: "s.t", text: "do it" }]);
    expect(out.partial).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/pack/); // internal fields stripped
  });
});

describe("isUuid", () => {
  it("accepts uuids, rejects junk", () => {
    expect(isUuid("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("buildBriefPrompt", () => {
  const agg = { todos: [{ key: "k", title: "Approvals", count: 3, severity: "action" }], processes: [], suggestions: [], partial: false };
  it("embeds the aggregate verbatim and the anti-fabrication rule", () => {
    const p = buildBriefPrompt(agg, "Eran", "2026-07-14");
    expect(p).toContain(JSON.stringify(agg));
    expect(p).toContain("NEVER invent");
    expect(p).toContain("Eran");
    expect(p).toContain("2026-07-14");
  });
  it("works without a name", () => {
    const p = buildBriefPrompt(agg, null, "2026-07-14");
    expect(p).not.toContain("named");
  });
});

describe("open_panel tool wiring", () => {
  const openPanel = TOOLS.find((t) => t.name === "open_panel");
  const getToday = TOOLS.find((t) => t.name === "get_today");

  it("both Phase-2 tools are defined", () => {
    expect(openPanel).toBeTruthy();
    expect(getToday).toBeTruthy();
  });
  it("open_panel is terminal; get_today is looped with an executor", () => {
    expect(TERMINAL_TOOLS.has("open_panel")).toBe(true);
    expect(TERMINAL_TOOLS.has("get_today")).toBe(false);
    expect(typeof TOOL_EXECUTORS.get_today).toBe("function");
    expect(TOOL_EXECUTORS.open_panel).toBeUndefined(); // terminal = no executor
  });
  it("open_panel enum mirrors the registry panel allowlist exactly", () => {
    const enumKeys = openPanel.input_schema.properties.panel.enum;
    expect([...enumKeys].sort()).toEqual([...panelKeys()].sort());
    expect(enumKeys.length).toBeGreaterThan(5);
  });
});

describe("per-app AI caps", () => {
  it("tangerine gets the raised caps; others keep the defaults", () => {
    expect(maxTokensForApp("tangerine")).toBe(2048);
    expect(maxIterationsForApp("tangerine")).toBe(14);
    expect(maxTokensForApp("ats")).toBe(MAX_TOKENS);
    expect(maxIterationsForApp(null)).toBe(MAX_TOOL_ITERATIONS);
  });
});
