// Lint guard: `COMMENT ON ... IS 'a ' || 'b';` is a Postgres syntax error.
//
// Postgres requires the COMMENT body to be a string LITERAL — || is not
// permitted in DDL constant expressions. We've shipped this bug three times:
//
//   - PR #373 (P4) → patched by PR #384
//   - PR #483 (P12-0) → patched by PR #485
//
// This lint reads every file in supabase/migrations/ and fails if any
// COMMENT ON ... IS statement contains a `' ||` pattern (string-literal
// followed by SQL concat operator), which is the exact bug shape.
//
// False-positive avoidance: only flags `' ||` (closing single-quote +
// optional whitespace + concat). A literal `||` inside a quoted COMMENT
// body (e.g. `'use a || b for cents'`) doesn't get caught because it
// isn't preceded by a closing quote.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../supabase/migrations");

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// Find every `COMMENT ON ... IS ... ;` statement and check its body
// for the bug pattern. Returns an array of { file, snippet } entries
// for any violations found.
function findCommentConcatViolations(file, sql) {
  const violations = [];
  // Strip `--` line comments that are NOT inside a string literal, so the
  // lint never flags its OWN doc examples (e.g. a `-- COMMENT ON ... IS
  // 'a ' || 'b'` explanatory line in a schema file). Quote-aware so a `--`
  // inside a quoted COMMENT body is preserved.
  const clean = sql.split("\n").map((line) => {
    let inStr = false, out = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'") { inStr = !inStr; out += c; continue; }
      if (!inStr && c === "-" && line[i + 1] === "-") break;
      out += c;
    }
    return out;
  }).join("\n");
  // Multi-line, ungreedy match of every `COMMENT ON ... IS ... ;` stmt.
  // Postgres allows COMMENT to be very free-form; the only thing we care
  // about is whether `' ||` appears between IS and the terminating `;`.
  const stmtRe = /COMMENT\s+ON\s+[\s\S]*?IS\s+[\s\S]*?;/gi;
  for (const match of clean.matchAll(stmtRe)) {
    const stmt = match[0];
    // Bug pattern: closing single-quote followed by optional whitespace
    // (incl. newline) followed by `||`.
    if (/'\s*\|\|/.test(stmt)) {
      // Truncate to a one-line snippet for the assertion failure msg.
      const snippet = stmt
        .replace(/\s+/g, " ")
        .slice(0, 160);
      violations.push({ file, snippet });
    }
  }
  return violations;
}

describe("supabase migrations — COMMENT ON string-concat lint", () => {
  it("no migration uses `' ||` inside a COMMENT ON ... IS statement", () => {
    const files = listMigrations();
    expect(files.length).toBeGreaterThan(0);

    const allViolations = [];
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      allViolations.push(...findCommentConcatViolations(f, sql));
    }

    if (allViolations.length > 0) {
      const msg = allViolations
        .map((v) => `  ${v.file}\n    ${v.snippet}`)
        .join("\n");
      throw new Error(
        `Found ${allViolations.length} COMMENT ON statement(s) using string concat.\n` +
          `Postgres requires a string LITERAL in COMMENT ON ... IS. Collapse to a single quoted string.\n\n` +
          msg,
      );
    }
  });

  it("detects the bug pattern in a synthetic violator", () => {
    const sample = `
      CREATE TABLE foo (id int);
      COMMENT ON TABLE foo IS
        'first half ' ||
        'second half';
    `;
    const violations = findCommentConcatViolations("synthetic.sql", sample);
    expect(violations.length).toBe(1);
  });

  it("does NOT false-positive on || inside a literal", () => {
    const sample = `
      CREATE TABLE foo (id int);
      COMMENT ON TABLE foo IS 'use a || b for cents math';
    `;
    const violations = findCommentConcatViolations("synthetic.sql", sample);
    expect(violations.length).toBe(0);
  });

  it("does NOT false-positive on || inside DO blocks", () => {
    // DO blocks contain runtime SQL where || is valid; this lint only
    // scans COMMENT ON statements, not DO bodies.
    const sample = `
      DO $$ BEGIN
        EXECUTE 'ALTER TABLE ' || quote_ident('foo') || ' SET LOGGED';
      END $$;
    `;
    const violations = findCommentConcatViolations("synthetic.sql", sample);
    expect(violations.length).toBe(0);
  });

  it("does NOT false-positive on single-literal COMMENT ON", () => {
    const sample = `
      COMMENT ON COLUMN foo.bar IS 'simple single-line comment';
      COMMENT ON COLUMN foo.baz IS 'comment with a trailing quote-marker ''see notes''';
    `;
    const violations = findCommentConcatViolations("synthetic.sql", sample);
    expect(violations.length).toBe(0);
  });
});
