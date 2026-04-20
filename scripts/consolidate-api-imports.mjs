#!/usr/bin/env node
// Rewrites relative imports of `_lib/` inside `api/_handlers/**/*.js`
// to add one extra `../` since the directory is now one level deeper.
// Idempotent — only rewrites the leading `(../)+_lib/` chain, never doubles.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "api", "_handlers");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && (e.name.endsWith(".js") || e.name.endsWith(".ts"))) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
let rewrote = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  // Match "(../)+_lib/..." inside import / require strings
  const next = src.replace(/((?:import|from|require)[^"']*["'])((?:\.\.\/)+)_lib\//g, "$1$2../_lib/");
  if (next !== src) {
    fs.writeFileSync(f, next);
    rewrote += 1;
  }
}
console.log(`Rewrote ${rewrote} file(s) of ${files.length}`);
