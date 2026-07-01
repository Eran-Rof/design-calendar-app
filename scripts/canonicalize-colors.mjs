#!/usr/bin/env node
// #2a — canonicalize ip_item_master.color to ONE spelling per physical color.
// The same color arrives spelled differently from different ingest paths
// (Black/BLACK, Light Wash/Lt Wash, Navy/Peach vs NAVY/PEACH), fragmenting
// matrices/on-hand/sales into duplicate rows.
//
// TARGETED + non-degrading: only rewrites colors in a (style, canonColor-key)
// group that actually holds 2+ distinct raw spellings, and rewrites the minority
// rows TO the BEST existing spelling in the group (prefer not-all-caps, then the
// longest — "SKYFALL - Light Wash" over "SKYFALL - Lt Wash", "Black" over
// "BLACK"). Colors that are the only spelling for their physical color are left
// untouched (no "GoldenOak"→"Goldenoak" degradation).
//
// SAFE: skips any rewrite that would COLLIDE with an existing (style, color,
// canonical-size, inseam) row — those are TRUE duplicate SKUs (the #2b
// physical-merge population, which repoints ~57 FK tables and needs its own
// signed-off migration). DRY-RUN by default; --apply writes prod + a reversal
// manifest. Prod via SUPABASE_PAT (.env.local), Management API.
//
//   node scripts/canonicalize-colors.mjs            # dry-run
//   node scripts/canonicalize-colors.mjs --apply    # write prod (+ manifest)

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonColor, normalizeSize } from "../api/_lib/styleMatrix.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const APPLY = process.argv.includes("--apply");

function pat() {
  for (const f of [".env.local", ".env.staging"]) {
    try {
      const txt = readFileSync(resolve(ROOT, f), "utf8");
      const m = txt.split("\n").find((l) => l.startsWith("SUPABASE_PAT"));
      if (m) return m.slice(m.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    } catch { /* next */ }
  }
  throw new Error("SUPABASE_PAT not found in .env.local");
}
const PAT = pat();

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`);
  return JSON.parse(text);
}

// 1. Pull every colored SKU.
const rows = await sql(
  `select id::text, style_id::text, color, size, inseam from ip_item_master where color is not null`,
);
console.log(`# scanned ${rows.length} colored SKUs`);

// 2. Only fragmented (style, canonKey) groups; pick the BEST existing spelling.
const groups = new Map(); // `${style_id}|${canonKey}` → Map(rawColor → count)
for (const r of rows) {
  const g = `${r.style_id}|${canonColor(r.color)}`;
  let m = groups.get(g); if (!m) { m = new Map(); groups.set(g, m); }
  m.set(r.color, (m.get(r.color) || 0) + 1);
}
const targetByGroup = new Map();
for (const [g, m] of groups) {
  if (m.size < 2) continue; // not fragmented → leave alone
  const best = [...m.entries()].sort((a, b) => {
    const aCaps = a[0] === a[0].toUpperCase(), bCaps = b[0] === b[0].toUpperCase();
    if (aCaps !== bCaps) return aCaps ? 1 : -1;      // non-all-caps first
    if (b[0].length !== a[0].length) return b[0].length - a[0].length; // longer first
    return b[1] - a[1];                               // more common first
  })[0][0];
  targetByGroup.set(g, best);
}

// Logical key (mirrors the DB unique index, size IS NOT NULL only) to skip
// collisions — a rewrite clashing with an existing row of the same size is a
// TRUE duplicate (the #2b physical-merge population).
const logicalKey = (r, colorForKey) =>
  r.size == null ? null
    : `${r.style_id}|${colorForKey ?? ""}|${normalizeSize(String(r.size))}|${r.inseam ? String(r.inseam).trim() : ""}`;
const occupied = new Set();
for (const r of rows) { const k = logicalKey(r, r.color); if (k) occupied.add(k); }

const updates = [];
let skippedCollision = 0;
for (const r of rows) {
  const g = `${r.style_id}|${canonColor(r.color)}`;
  const target = targetByGroup.get(g);
  if (!target || target === r.color) continue; // not fragmented, or already the target
  const k = logicalKey(r, target);
  if (k && occupied.has(k)) { skippedCollision++; continue; } // true-dup → #2b
  if (k) occupied.add(k); // reserve so a 2nd row can't map to the same size-key
  updates.push({ id: r.id, old: r.color, new: target });
}

console.log(`# fragmented groups=${targetByGroup.size}  toUpdate=${updates.length}  skippedCollision(true-dup #2b)=${skippedCollision}`);
console.log(`# sample:`, updates.slice(0, 8).map((u) => `${u.old} → ${u.new}`));

if (!APPLY) { console.log("# DRY-RUN — no writes. Re-run with --apply."); process.exit(0); }
if (updates.length === 0) { console.log("# nothing to update"); process.exit(0); }

// Reversal manifest, then one UPDATE ... FROM (VALUES ...) per 500.
const manifestPath = resolve(ROOT, "..", "code", "rof_xoro_project", ".launchd-logs", "color-canon-REVERSAL-2026-06-30.json");
writeFileSync(manifestPath, JSON.stringify({ applied: "2026-06-30", updates }, null, 1));
console.log(`# reversal manifest: ${manifestPath}`);

const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
let applied = 0;
for (let i = 0; i < updates.length; i += 500) {
  const chunk = updates.slice(i, i + 500);
  const values = chunk.map((u) => `(${esc(u.id)}::uuid, ${esc(u.new)})`).join(",");
  await sql(`update ip_item_master im set color = v.c from (values ${values}) v(id, c) where im.id = v.id`);
  applied += chunk.length;
}
console.log(`# APPLIED ${applied} color canonicalizations`);
