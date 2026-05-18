// Golden Q&A eval suite for the Ask AI surface.
//
// Hits the LIVE Ask AI endpoint with a small set of canonical operator
// questions and asserts on the tools the AI called + the answer text.
// This is the safety net for prompt edits — when the SYSTEM_PROMPT or
// glossary changes, run this to catch the AI silently routing through
// the wrong tool, fabricating, or losing critical instructions.
//
// Gated on RUN_AI_EVAL=1 (skipped in normal CI). Real API hits cost
// roughly $0.01-$0.15 per fixture, ~$0.50-$1.00 for the full run.
//
// Requirements when running:
//   - Anthropic + Supabase env vars set (same as the dev server needs).
//   - A running Vercel-style dev server reachable at AI_EVAL_BASE_URL
//     (defaults to http://localhost:3000). Start with `npm run dev:api`.
//
// Invoke via: `npm run test:eval`

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const SHOULD_RUN = process.env.RUN_AI_EVAL === "1";
const BASE_URL   = process.env.AI_EVAL_BASE_URL || "http://localhost:3000";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = resolvePath(here, "./golden-questions.fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

// Static-shape default grid context used unless a fixture overrides.
// Mirrors what AskAIPanel sends from the ATS NavBar so the AI's
// grid-context block looks realistic.
const DEFAULT_GRID_CONTEXT = {
  today: new Date().toISOString().slice(0, 10),
  active_filters: {},
  sort: null,
  row_count: 0,
  columns: ["sku", "style_code", "description", "category", "store", "onHand", "onOrder", "onPO"],
  distinct: {
    categories: ["Mens Bottoms", "Mens Tops", "Womens Bottoms"],
    sub_categories: ["Slim Denim", "Jogger"],
    styles: ["RYB0412", "RBB1234"],
    genders: ["Mens", "Womens"],
    stores: ["ROF", "ROF ECOM", "PT"],
  },
};

async function runFixture(fixture) {
  const body = {
    question:     fixture.question,
    history:      fixture.history || [],
    grid_context: DEFAULT_GRID_CONTEXT,
    user_id:      "eval-suite-runner",
    app_id:       "ats",
  };
  const r = await fetch(`${BASE_URL}/api/ai/ask-grid`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} on /api/ai/ask-grid: ${text.slice(0, 300)}`);
  }
  return r.json();
}

function assertFixture(fixture, response) {
  const a = fixture.assertions || {};
  const calledTools = (response.trace || []).map(t => t.tool);
  const text = String(response.text || "");

  if (a.must_call_tools) {
    for (const tool of a.must_call_tools) {
      expect(calledTools, `[${fixture.name}] must call '${tool}', got ${JSON.stringify(calledTools)}`).toContain(tool);
    }
  }
  if (a.must_not_call_tools) {
    for (const tool of a.must_not_call_tools) {
      expect(calledTools, `[${fixture.name}] must NOT call '${tool}', got ${JSON.stringify(calledTools)}`).not.toContain(tool);
    }
  }
  if (a.answer_must_contain_any) {
    const lowered = text.toLowerCase();
    const matched = a.answer_must_contain_any.some(s => lowered.includes(s.toLowerCase()));
    expect(matched, `[${fixture.name}] answer should contain one of ${JSON.stringify(a.answer_must_contain_any)} — got: ${text.slice(0, 200)}…`).toBe(true);
  }
  if (a.answer_must_not_contain) {
    const lowered = text.toLowerCase();
    for (const banned of a.answer_must_not_contain) {
      expect(lowered.includes(banned.toLowerCase()), `[${fixture.name}] answer should NOT contain '${banned}' — got: ${text.slice(0, 200)}…`).toBe(false);
    }
  }
  if (a.max_cost_usd) {
    const cost = Number(response.token_usage?.cost_usd ?? 0);
    expect(cost, `[${fixture.name}] cost $${cost.toFixed(4)} exceeded budget $${a.max_cost_usd}`).toBeLessThanOrEqual(a.max_cost_usd);
  }
}

const describeFn = SHOULD_RUN ? describe : describe.skip;

describeFn("golden Q&A eval (real Anthropic API — gated on RUN_AI_EVAL=1)", () => {
  // 60s per fixture — vision + multi-tool chains can run long.
  for (const fixture of fixtures) {
    it(fixture.name, { timeout: 60_000 }, async () => {
      const response = await runFixture(fixture);
      assertFixture(fixture, response);
    });
  }
});

// Always-on sanity test: even when the eval is gated, validate that
// the fixture file at least PARSES and has the shape we expect.
describe("golden Q&A eval: fixture file shape", () => {
  it("loads without parse error", () => {
    expect(Array.isArray(fixtures)).toBe(true);
    expect(fixtures.length).toBeGreaterThan(0);
  });
  it("each fixture has the required keys", () => {
    for (const f of fixtures) {
      expect(typeof f.name).toBe("string");
      expect(typeof f.question).toBe("string");
      expect(f.assertions, `[${f.name}] missing assertions block`).toBeTruthy();
    }
  });
  it("no duplicate fixture names", () => {
    const seen = new Set();
    for (const f of fixtures) {
      expect(seen.has(f.name), `Duplicate fixture name: ${f.name}`).toBe(false);
      seen.add(f.name);
    }
  });
});
