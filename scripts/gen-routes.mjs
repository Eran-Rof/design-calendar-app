#!/usr/bin/env node
// Generates api/_handlers/routes.js from api/_handlers/routes.manifest.js.
//
// Why this replaces the old scripts/generate-api-routes.mjs:
//   • The old generator named handlers `h${i}` by sorted INDEX, so any
//     regen renumbered every handler → giant conflicts (hence the
//     "APPEND never regen" rule and the hand-maintained routes.js that
//     drifted, which is how the #945 duplicate-`h527` outage happened).
//   • It also derived every pattern from the FILE PATH, so it could not
//     express the ~31 routes that inject an :id the path can't encode
//     (sales-orders/ship.js → /api/internal/sales-orders/:id/ship) and
//     it never walked api/cron, so crons were missing entirely.
//
// This generator instead reads the patterns from the manifest (data) and
// names imports from the MODULE PATH (stable — adding/removing a handler
// never renumbers the others). Two PRs adding different handlers get
// different, path-derived names → the duplicate-identifier cold-start
// crash is impossible by construction. The routing table is emitted in
// specificity order (literal segments before :params before *catch-alls)
// so source order is irrelevant and a new literal route can never be
// shadowed by an existing :id sibling.
//
// Usage:
//   node scripts/gen-routes.mjs           regenerate routes.js
//   node scripts/gen-routes.mjs --check   fail (exit 1) if routes.js is
//                                          stale vs the manifest (CI gate)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HANDLERS = resolve(fileURLToPath(import.meta.url), "..", "..", "api", "_handlers");
const ROUTES_FILE = resolve(HANDLERS, "routes.js");
const MANIFEST_FILE = resolve(HANDLERS, "routes.manifest.js");

const manifest = (await import("file://" + MANIFEST_FILE.replace(/\\/g, "/"))).default;
if (!Array.isArray(manifest) || manifest.length === 0) {
  console.error("✖ routes.manifest.js did not default-export a non-empty array");
  process.exit(1);
}

// ── derive a stable, unique JS identifier from a module path ───────────
//   "./internal/sales-orders/ship.js"     → r_internal_sales_orders_ship
//   "../cron/crm-tasks-due-tomorrow.js"   → r_cron_crm_tasks_due_tomorrow
//   "./vendor/.../[id]/respond.js"        → r_vendor_..._id_respond
function baseName(modulePath) {
  const cleaned = modulePath
    .replace(/^(\.\.?\/)+/, "")   // leading ./ or ../
    .replace(/\.js$/, "")
    .replace(/\[([^\]]+)\]/g, "$1"); // [id] → id
  const id = "r_" + cleaned.replace(/[^A-Za-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return id || "r_root";
}

// One import per distinct module (a future N-patterns→1-handler is fine).
const modules = [...new Set(manifest.map(([, m]) => m))];
const nameOf = new Map();
const used = new Map(); // base → count, for deterministic disambiguation
for (const m of [...modules].sort()) {
  let name = baseName(m);
  if (used.has(name)) {
    const n = used.get(name) + 1;
    used.set(name, n);
    name = `${name}_${n}`; // stable: ordered by sorted module path
  } else {
    used.set(name, 1);
  }
  nameOf.set(m, name);
}

// ── specificity order: more literal segments win, catch-alls last ──────
function specificityKey(pattern) {
  const segs = pattern.split("/").filter(Boolean);
  const nonParam = segs.filter((s) => !s.startsWith(":") && !s.startsWith("*")).length;
  const hasCatchall = segs.some((s) => s.startsWith("*"));
  return [hasCatchall ? 0 : 1, nonParam, segs.length, pattern.length];
}
const ordered = [...manifest].sort((a, b) => {
  const ka = specificityKey(a[0]);
  const kb = specificityKey(b[0]);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; // final tiebreak: stable by pattern
});

// ── emit ───────────────────────────────────────────────────────────────
const L = [];
L.push("// AUTO-GENERATED from routes.manifest.js by scripts/gen-routes.mjs.");
L.push("// DO NOT EDIT BY HAND — edit routes.manifest.js, then `npm run gen:routes`.");
L.push("// (CI runs `gen:routes --check` and fails if this file is stale.)");
L.push("//");
L.push("// Single api/dispatch.js function imports every handler statically here");
L.push("// so Vercel bundles them all behind one serverless function.");
L.push("");
for (const m of [...modules].sort()) L.push(`import ${nameOf.get(m)} from "${m}";`);
L.push("");
L.push("export const ROUTES = [");
for (const [pattern, m] of ordered) L.push(`  { pattern: ${JSON.stringify(pattern)}, handler: ${nameOf.get(m)} },`);
L.push("];");
L.push("");
L.push("export function compileRoutes(routes) {");
L.push("  return routes.map((r) => {");
L.push("    const segs = r.pattern.split(\"/\").filter(Boolean);");
L.push("    const params = [];");
L.push("    const regexParts = segs.map((seg) => {");
L.push("      if (seg.startsWith(\":\")) { params.push(seg.slice(1)); return \"([^/]+)\"; }");
L.push("      if (seg.startsWith(\"*\")) { params.push(seg.slice(1)); return \"(.+)\"; }");
L.push("      return seg.replace(/[.*+?^${}()|[\\]\\\\]/g, \"\\\\$&\");");
L.push("    });");
L.push("    const regex = new RegExp(\"^/\" + regexParts.join(\"/\") + \"/?$\");");
L.push("    return { ...r, regex, params };");
L.push("  });");
L.push("}");
L.push("");
const content = L.join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(ROUTES_FILE, "utf8"); } catch { /* missing */ }
  // Compare line-ending-agnostic — git may check out routes.js as CRLF on
  // Windows while the generator always emits LF; that's not "stale".
  const norm = (s) => s.replace(/\r\n/g, "\n");
  if (norm(current) !== norm(content)) {
    console.error("✖ routes.js is STALE vs routes.manifest.js. Run `npm run gen:routes` and commit.");
    process.exit(1);
  }
  console.log(`✓ routes.js is up to date (${manifest.length} routes, ${modules.length} handlers).`);
} else {
  writeFileSync(ROUTES_FILE, content);
  console.log(`✓ generated routes.js — ${manifest.length} routes, ${modules.length} handlers.`);
}
