#!/usr/bin/env node
// CI smoke-check for the api/ layer.
//
// Why this exists: the "Tests" workflow runs `tsc --noEmit` (TypeScript
// only) + vitest (which never imports the dispatcher). The entire api/
// layer is plain .js, so a SyntaxError or a bad/stale import there sails
// through CI green and only explodes at RUNTIME on Vercel — and because
// every route funnels through the single function api/dispatch.js, that
// means `500 FUNCTION_INVOCATION_FAILED` on EVERY route at once. That is
// exactly the 2026-06-04 outage (a duplicate `import h527` = SyntaxError
// that crashed dispatch.js on cold start). See memory
// project_dispatcher_h_number_collision_outage.
//
// This closes the blind spot with three fully-static checks (no handler
// is executed, no env/network needed — safe to run anywhere):
//   1. `node --check` on every api/**/*.js  → syntax + duplicate-identifier
//      (the h527 crash was a dup import, which IS a parse-time error).
//   2. routes.js: every `import x from "<relpath>"` resolves to a real
//      file  → catches importing a deleted/renamed handler. (node --check
//      is parse-only and does NOT resolve modules, so it misses this.)
//   3. routes.js: no duplicate default-import identifier, and every
//      `handler: x` in the ROUTES table references an imported name.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const API = join(ROOT, "api");

const rel = (p) => p.replace(ROOT, "").replace(/^[/\\]/, "").replace(/\\/g, "/");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

const errors = [];

// ── Check 1: parse every api/**/*.js with `node --check` ──────────────
function nodeCheck(file) {
  return new Promise((res) => {
    execFile(process.execPath, ["--check", file], (err, _stdout, stderr) => {
      res(err ? { file, msg: (stderr || err.message).trim() } : null);
    });
  });
}
async function pool(items, fn, conc = 24) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, items.length) }, async () => {
      while (i < items.length) { const idx = i++; out.push(await fn(items[idx])); }
    }),
  );
  return out.filter(Boolean);
}

const files = walk(API);
for (const e of await pool(files, nodeCheck)) {
  errors.push(`SYNTAX  ${rel(e.file)}\n        ${e.msg.split("\n").slice(0, 3).join("\n        ")}`);
}

// ── Checks 2 & 3: static analysis of routes.js ────────────────────────
const routesPath = join(API, "_handlers", "routes.js");
const src = readFileSync(routesPath, "utf8");
const routesDir = dirname(routesPath);
const lineOf = (idx) => src.slice(0, idx).split("\n").length;

const importRe = /^import\s+(\w+)\s+from\s+"([^"]+)";/gm;
const firstSeen = new Map(); // identifier -> line of first declaration
const imported = new Set();
let m;
while ((m = importRe.exec(src))) {
  const [, name, spec] = m;
  const ln = lineOf(m.index);
  if (firstSeen.has(name)) {
    errors.push(`DUP-IMPORT  routes.js:${ln} re-declares '${name}' (first at :${firstSeen.get(name)}) — this crashes dispatch.js on cold start`);
  } else {
    firstSeen.set(name, ln);
  }
  imported.add(name);
  if (spec.startsWith(".")) {
    const target = resolve(routesDir, spec);
    if (!existsSync(target)) {
      errors.push(`MISSING-MODULE  routes.js:${ln} imports "${spec}" → ${rel(target)} does not exist`);
    }
  }
}

// Scope the `handler:` scan to the ROUTES = [ ... ] array so we don't
// match unrelated object keys elsewhere in the file.
const rStart = src.indexOf("export const ROUTES = [");
const rEnd = rStart >= 0 ? src.indexOf("\n];", rStart) : -1;
if (rStart >= 0 && rEnd > rStart) {
  const block = src.slice(rStart, rEnd);
  const handlerRe = /handler:\s*(\w+)\s*[},]/g;
  while ((m = handlerRe.exec(block))) {
    if (!imported.has(m[1])) {
      errors.push(`UNDEFINED-HANDLER  routes.js:${lineOf(rStart + m.index)} references '${m[1]}' which is never imported`);
    }
  }
}

if (errors.length) {
  console.error(`\n✖ api/ smoke-check FAILED (${errors.length} problem${errors.length > 1 ? "s" : ""}):\n`);
  for (const e of errors) console.error("  " + e + "\n");
  process.exit(1);
}
console.log(`✓ api/ smoke-check passed — ${files.length} files parsed, ${imported.size} handler imports resolved.`);
