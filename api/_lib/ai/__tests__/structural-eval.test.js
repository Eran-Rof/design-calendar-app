// Structural eval suite for the Ask AI surface.
//
// Runs on every commit. NO Anthropic API calls — only assertions on
// the shape of the modules. Catches the most-likely-to-regress class
// of bug: tool definitions silently going out of sync with executors,
// system-prompt edits that drop critical instructions, workflow enum
// drift, TOOL_LABELS pointing at non-existent tools, etc.
//
// Companion to api/_lib/ai/__tests__/golden-questions.test.js (the
// real-AI eval, gated on RUN_AI_EVAL=1).

import { describe, it, expect } from "vitest";
import { TOOLS } from "../tool-defs.js";
import { TOOL_EXECUTORS } from "../executors.js";
import { TERMINAL_TOOLS, TOOL_LABELS } from "../constants.js";
import { SYSTEM_PROMPT } from "../system-prompt.js";
import { ROF_GLOSSARY } from "../rof-glossary.js";
import { WORKFLOWS } from "../workflows.js";

// ────────────────────────────────────────────────────────────────────────
// Tool definitions ↔ executors
// ────────────────────────────────────────────────────────────────────────

describe("structural eval: tools", () => {
  it("every tool in TOOLS has a matching executor OR is terminal", () => {
    for (const t of TOOLS) {
      const isTerminal = TERMINAL_TOOLS.has(t.name);
      const hasExecutor = !!TOOL_EXECUTORS[t.name];
      expect(isTerminal || hasExecutor, `Tool '${t.name}' has neither an executor nor a TERMINAL_TOOLS entry`).toBe(true);
    }
  });

  it("every executor key appears in TOOLS (no orphan executors)", () => {
    const toolNames = new Set(TOOLS.map(t => t.name));
    for (const name of Object.keys(TOOL_EXECUTORS)) {
      expect(toolNames.has(name), `Executor '${name}' has no matching TOOLS entry`).toBe(true);
    }
  });

  it("every TERMINAL_TOOLS entry exists in TOOLS", () => {
    const toolNames = new Set(TOOLS.map(t => t.name));
    for (const name of TERMINAL_TOOLS) {
      expect(toolNames.has(name), `TERMINAL_TOOLS includes '${name}' but it's not in TOOLS`).toBe(true);
    }
  });

  it("every TOOL_LABELS key maps to a real tool name", () => {
    const toolNames = new Set(TOOLS.map(t => t.name));
    for (const name of Object.keys(TOOL_LABELS)) {
      expect(toolNames.has(name), `TOOL_LABELS has '${name}' but it's not in TOOLS`).toBe(true);
    }
  });

  it("each tool definition has the required input_schema shape", () => {
    for (const t of TOOLS) {
      expect(t.name).toBeTruthy();
      expect(typeof t.description, `${t.name}: description must be a string`).toBe("string");
      expect(t.description.length, `${t.name}: description must be non-empty`).toBeGreaterThan(10);
      expect(t.input_schema, `${t.name}: missing input_schema`).toBeTruthy();
      expect(t.input_schema.type, `${t.name}: input_schema.type must be "object"`).toBe("object");
    }
  });

  it("no duplicate tool names", () => {
    const seen = new Set();
    for (const t of TOOLS) {
      expect(seen.has(t.name), `Duplicate tool name: ${t.name}`).toBe(false);
      seen.add(t.name);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// System prompt + glossary integrity
// ────────────────────────────────────────────────────────────────────────

describe("structural eval: system prompt", () => {
  it("SYSTEM_PROMPT is composed of RULES + ROF_GLOSSARY (not silently empty)", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(2000);
    expect(SYSTEM_PROMPT.endsWith(ROF_GLOSSARY)).toBe(true);
  });

  it("ROF_GLOSSARY isn't truncated / minified to nothing", () => {
    expect(typeof ROF_GLOSSARY).toBe("string");
    expect(ROF_GLOSSARY.length).toBeGreaterThan(1000);
  });

  it("mentions every critical tool the AI is supposed to know exists", () => {
    // If any of these silently disappear from the prompt, the AI may
    // stop calling them — these are load-bearing names.
    const critical = [
      "answer_text",
      "find_customer",
      "find_style",
      "query_shipments",
      "query_margin",
      "style_card",
      "customer_card",
      "lookup_user_facts",
      "start_workflow",
      "suggest_followups",
    ];
    for (const name of critical) {
      expect(SYSTEM_PROMPT.includes(name), `SYSTEM_PROMPT should mention '${name}'`).toBe(true);
    }
  });

  it("ANTI-FABRICATION section survives in the glossary", () => {
    expect(ROF_GLOSSARY).toMatch(/anti-?fabrication/i);
  });

  it("FETCH AND ANSWER + SHORT REPLY HANDLING sections survive in the glossary", () => {
    expect(ROF_GLOSSARY).toMatch(/FETCH AND ANSWER/);
    expect(ROF_GLOSSARY).toMatch(/SHORT REPLY/i);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Workflow definitions ↔ tool-def enum
// ────────────────────────────────────────────────────────────────────────

describe("structural eval: workflows", () => {
  it("every WORKFLOWS entry appears in the start_workflow tool's workflow_name enum", () => {
    const startWorkflow = TOOLS.find(t => t.name === "start_workflow");
    expect(startWorkflow, "start_workflow tool missing from TOOLS").toBeTruthy();
    const enumValues = startWorkflow.input_schema.properties.workflow_name.enum || [];
    const enumSet = new Set(enumValues);
    for (const wf of WORKFLOWS) {
      expect(enumSet.has(wf.name), `Workflow '${wf.name}' exists but isn't in the start_workflow enum`).toBe(true);
    }
  });

  it("every workflow_name enum value is a real WORKFLOWS entry", () => {
    const startWorkflow = TOOLS.find(t => t.name === "start_workflow");
    const wfNames = new Set(WORKFLOWS.map(w => w.name));
    const enumValues = startWorkflow.input_schema.properties.workflow_name.enum || [];
    for (const val of enumValues) {
      expect(wfNames.has(val), `start_workflow enum lists '${val}' but no such workflow exists`).toBe(true);
    }
  });

  it("each workflow has a name, description, and callable run()", () => {
    for (const wf of WORKFLOWS) {
      expect(typeof wf.name).toBe("string");
      expect(typeof wf.description).toBe("string");
      expect(wf.description.length).toBeGreaterThan(30);
      expect(typeof wf.run).toBe("function");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Module size ceilings (architecture invariant #1 + #2)
// ────────────────────────────────────────────────────────────────────────

describe("structural eval: module sizes", () => {
  // Stat the source files via Node fs. Vitest exposes import.meta.url
  // so we can resolve paths relative to this test file.
  async function lineCount(relPath) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = url.fileURLToPath(import.meta.url);
    const abs  = path.resolve(path.dirname(here), relPath);
    const txt  = fs.readFileSync(abs, "utf8");
    return txt.split("\n").length;
  }

  it("api/_handlers/ai/ask-grid.js stays under ~400 lines (invariant #1)", async () => {
    const n = await lineCount("../../../_handlers/ai/ask-grid.js");
    expect(n).toBeLessThan(500);
  });

  it("api/_lib/ai/executors.js stays under ~700 lines (invariant #2)", async () => {
    const n = await lineCount("../executors.js");
    expect(n).toBeLessThan(750);
  });

  it("api/_lib/ai/streaming.js stays under ~400 lines", async () => {
    const n = await lineCount("../streaming.js");
    expect(n).toBeLessThan(500);
  });
});
