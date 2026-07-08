// Guards the data-driven routing (routes.manifest.js → routes.js).
// Complements the CI gates `npm run gen:routes -- --check` (staleness) and
// `npm run check:api` (parse + import resolution). Here we assert the
// manifest's integrity and that the generated table matches by specificity
// — the property that lets manifest order be arbitrary without a literal
// route being shadowed by an :id sibling.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../routes.manifest.js";

const HANDLERS = resolve(fileURLToPath(import.meta.url), "..", "..");

describe("API routing manifest", () => {
  it("default-exports a non-empty [pattern, module] array", () => {
    expect(Array.isArray(manifest)).toBe(true);
    expect(manifest.length).toBeGreaterThan(500);
    for (const entry of manifest) {
      expect(Array.isArray(entry)).toBe(true);
      expect(typeof entry[0]).toBe("string"); // pattern
      expect(typeof entry[1]).toBe("string"); // module path
      expect(entry[0].startsWith("/api/")).toBe(true);
    }
  });

  it("has no duplicate URL patterns", () => {
    const seen = new Set();
    const dups = [];
    for (const [p] of manifest) { if (seen.has(p)) dups.push(p); else seen.add(p); }
    expect(dups).toEqual([]);
  });

  it("every handler module resolves to a file on disk", () => {
    const missing = manifest
      .filter(([, m]) => !existsSync(resolve(HANDLERS, m)))
      .map(([p, m]) => `${p} -> ${m}`);
    expect(missing).toEqual([]);
  });

  // Importing routes.js loads 700+ handler modules — legitimately slow and
  // grows with every route; the 5s default started flaking at ~708 routes.
  it("generated ROUTES covers exactly the manifest patterns", { timeout: 60_000 }, async () => {
    const { ROUTES } = await import("../routes.js");
    expect(ROUTES.length).toBe(manifest.length);
    expect(new Set(ROUTES.map((r) => r.pattern))).toEqual(new Set(manifest.map(([p]) => p)));
  });

  it("matches by specificity: a literal sibling is not shadowed by its :id route", async () => {
    const { ROUTES, compileRoutes } = await import("../routes.js");
    const compiled = compileRoutes(ROUTES);
    const resolveHandler = (path) => {
      for (const r of compiled) if (r.regex.test(path)) return r.handler;
      return null;
    };
    // Both routes exist in the table; the literal must win for its exact path.
    const literal = resolveHandler("/api/internal/vendors/diversity");
    const param = resolveHandler("/api/internal/vendors/12345");
    expect(literal).toBeTruthy();
    expect(param).toBeTruthy();
    expect(literal).not.toBe(param); // distinct handlers — literal not swallowed
  });
});
