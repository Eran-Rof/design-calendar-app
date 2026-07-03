#!/usr/bin/env node
// Type-check ratchet.
//
// Why this exists: the repo root tsconfig.json is solution-style ("files": []
// + project references), so `tsc -p tsconfig.json` (the old CI command)
// type-checks NOTHING without `--build`. The gate was a silent no-op, so ~157
// type errors accumulated — including a couple of genuine runtime
// ReferenceErrors (collapseCols #1438, itemMap #1439) that reached prod.
//
// Flipping CI to a clean `tsc -b` would fail on all 157 at once. Instead this
// ratchet runs the REAL build-mode check and fails CI only on errors that are
// NOT already in the committed baseline (scripts/typecheck-baseline.txt). New
// type errors are blocked; the existing debt is grandfathered and shrinks as
// files get fixed.
//
//   node scripts/typecheck-ratchet.mjs            # check (CI) — exit 1 on NEW errors
//   node scripts/typecheck-ratchet.mjs --update   # regenerate the baseline
//
// Run --update from a clean tree where node_modules resolves (CI, or a real
// checkout) — NOT from a symlinked worktree, which adds bogus "Cannot find
// module 'react'" noise.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, "typecheck-baseline.txt");
const UPDATE = process.argv.includes("--update");
const TSC = join(here, "..", "node_modules", "typescript", "bin", "tsc");

// `--force` guarantees a full re-check (incremental .tsbuildinfo can otherwise
// suppress diagnostics on an "up to date" build). The referenced projects set
// noEmit, so nothing is written.
let out = "";
try {
  out = execFileSync("node", [TSC, "-b", "--force"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  out = (e.stdout || "") + (e.stderr || "");
}

// Normalize each diagnostic to a stable signature WITHOUT line/column numbers
// (those shift on every edit). Path separators normalized to "/" so the
// baseline is identical on Windows and Linux.
//   src/foo.tsx(12,5): error TS2304: Cannot find name 'x'.
//   → src/foo.tsx | TS2304 | Cannot find name 'x'.
const sig = (line) => {
  const m = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/);
  return m ? `${m[1].replace(/\\/g, "/")} | ${m[2]} | ${m[3]}` : null;
};
const current = [...new Set(out.split(/\r?\n/).map(sig).filter(Boolean))].sort();

if (UPDATE) {
  writeFileSync(BASELINE, current.length ? current.join("\n") + "\n" : "", "utf8");
  console.log(`Baseline updated: ${current.length} known type error(s) -> scripts/typecheck-baseline.txt`);
  process.exit(0);
}

const baseline = new Set(existsSync(BASELINE) ? readFileSync(BASELINE, "utf8").split(/\r?\n/).filter(Boolean) : []);
const novel = current.filter((s) => !baseline.has(s));
const fixed = [...baseline].filter((s) => !current.includes(s));

if (novel.length) {
  console.error(`\nX  ${novel.length} NEW type error(s) not in the baseline:\n`);
  for (const s of novel) console.error("   " + s);
  console.error(`\nFix them. If a baselined error genuinely moved, run: npm run typecheck:update\n`);
  process.exit(1);
}
console.log(`OK  type-check ratchet passed - ${current.length} known error(s), 0 new.`);
if (fixed.length) console.log(`    (${fixed.length} baselined error(s) now resolved - run \`npm run typecheck:update\` to shrink the baseline.)`);
process.exit(0);
