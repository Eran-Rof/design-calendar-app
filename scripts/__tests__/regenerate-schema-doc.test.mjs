// Tests for the schema-doc generator's parser helpers.
//
// We can't easily test the full pipeline (requires the migrations dir),
// but we can test the column-def parser + paren-balance + comma splitter
// on synthetic inputs. That covers the bug classes we actually hit.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "../regenerate-schema-doc.mjs"), "utf8");

// Load the module by dynamic import — but the script auto-runs main().
// To unit-test the helpers, we re-execute the source as text and eval just
// the helper definitions. The cleanest path: extract via regex.

function evalHelpers() {
  // Strip everything after the `function main()` definition so import
  // doesn't run the side effect.
  const cleaned = SOURCE.replace(/function main\(\)[\s\S]+$/, "")
    .replace(/^#!.*$/m, "")
    .replace(/^import .+;$/gm, "")
    .replace(/^const __dirname.+;$/gm, "")
    .replace(/^const REPO_ROOT.+;$/gm, "")
    .replace(/^const MIGRATIONS_DIR.+;$/gm, "")
    .replace(/^const OUT_PATH.+;$/gm, "");
  const fn = new Function(
    cleaned +
      "; return { findMatchingClose, splitTopLevelCommas, parseColumnDef, formatColumn, findCreateTables, findAlterTables };",
  );
  return fn();
}

const H = evalHelpers();

describe("findMatchingClose", () => {
  it("matches simple parens", () => {
    expect(H.findMatchingClose("(abc)", 0)).toBe(4);
  });
  it("handles nested parens", () => {
    expect(H.findMatchingClose("(a (b) c)", 0)).toBe(8);
  });
  it("ignores parens inside single-quoted strings", () => {
    expect(H.findMatchingClose("('(' || ')')", 0)).toBe(11);
  });
  it("ignores parens inside dollar-quoted bodies", () => {
    const s = "($foo$ ) ( $foo$ x)";
    // Outer: ( ... )
    // Inside the $foo$..$foo$ body, the lone `)` should NOT close.
    expect(H.findMatchingClose(s, 0)).toBe(s.length - 1);
  });
  it("returns -1 on unbalanced", () => {
    expect(H.findMatchingClose("(a (b)", 0)).toBe(-1);
  });
});

describe("splitTopLevelCommas", () => {
  it("splits simple", () => {
    expect(H.splitTopLevelCommas("a, b, c")).toEqual(["a", "b", "c"]);
  });
  it("preserves nested-paren commas", () => {
    expect(H.splitTopLevelCommas("a, b CHECK (x IN ('a','b','c')), d")).toEqual([
      "a",
      "b CHECK (x IN ('a','b','c'))",
      "d",
    ]);
  });
  it("preserves commas in strings", () => {
    expect(H.splitTopLevelCommas("a DEFAULT 'x,y', b")).toEqual(["a DEFAULT 'x,y'", "b"]);
  });
});

describe("parseColumnDef", () => {
  it("rejects constraint clauses", () => {
    expect(H.parseColumnDef("CONSTRAINT foo CHECK (x>0)")).toBeNull();
    expect(H.parseColumnDef("PRIMARY KEY (id)")).toBeNull();
    expect(H.parseColumnDef("UNIQUE (a, b)")).toBeNull();
  });
  it("parses simple column", () => {
    const c = H.parseColumnDef("id uuid PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(c.name).toBe("id");
    expect(c.type).toBe("uuid");
    expect(c.pk).toBe(true);
    expect(c.default).toBe("gen_random_uuid()");
  });
  it("parses REFERENCES + NOT NULL", () => {
    const c = H.parseColumnDef("entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT");
    expect(c.name).toBe("entity_id");
    expect(c.type).toBe("uuid");
    expect(c.notNull).toBe(true);
    expect(c.ref).toBe("entities");
  });
  it("parses inline CHECK with nested parens", () => {
    const c = H.parseColumnDef("status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))");
    expect(c.name).toBe("status");
    expect(c.notNull).toBe(true);
    expect(c.default).toBe("'open'");
    expect(c.check).toContain("status IN");
  });
});

describe("findCreateTables", () => {
  it("finds multiple CREATE TABLE blocks with function bodies between them", () => {
    const sql = `
CREATE TABLE x (id uuid PRIMARY KEY, name text);
CREATE FUNCTION trigger_fn() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TABLE y (a int, b int CHECK (b > 0));
`;
    const out = H.findCreateTables(sql);
    expect(out.map((c) => c.name)).toEqual(["x", "y"]);
    expect(out[0].inner).toContain("id uuid PRIMARY KEY");
    expect(out[1].inner).toContain("b int CHECK (b > 0)");
  });
  it("handles IF NOT EXISTS + schema-qualified names", () => {
    const sql = `CREATE TABLE IF NOT EXISTS public.foo (id uuid);`;
    const out = H.findCreateTables(sql);
    expect(out[0].name).toBe("foo");
  });
  it("survives nested CHECK with quoted strings", () => {
    const sql = `CREATE TABLE t (status text CHECK (status IN ('open','closed','in progress')));`;
    const out = H.findCreateTables(sql);
    expect(out).toHaveLength(1);
    expect(out[0].inner).toContain("status IN");
  });
});

describe("findAlterTables", () => {
  it("captures ADD COLUMN", () => {
    const sql = `ALTER TABLE foo ADD COLUMN bar text;`;
    const out = H.findAlterTables(sql);
    expect(out[0].name).toBe("foo");
    expect(out[0].body).toContain("ADD COLUMN bar text");
  });
  it("captures multi-clause ADD COLUMN IF NOT EXISTS", () => {
    const sql = `ALTER TABLE customers ADD COLUMN IF NOT EXISTS a text, ADD COLUMN IF NOT EXISTS b int;`;
    const out = H.findAlterTables(sql);
    expect(out[0].name).toBe("customers");
    expect(out[0].body).toContain("a text");
    expect(out[0].body).toContain("b int");
  });
});
