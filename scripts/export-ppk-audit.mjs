// One-off audit dump for the prepack rows that fed pack_size during
// the 20260517220000_item_master_pack_size.sql backfill.
//
// Output (CSV):
//   BasePart, Description, PPKQty, SizeExample
//
// Rules:
//   • Include rows where pack_size > 1 AND (style_code matches /PPK\d+/i
//     OR size matches /PPK\d+/i). Rows where the PPK signal lived only
//     in sku_code (and never made it into style/size) are excluded —
//     they're the noisy ones the planner wanted to skim past.
//   • One row per (style_code, pack_size) pair. Description = the first
//     matching row's description.
//   • SizeExample populated only when the PPK token comes from the size
//     column (lets the planner confirm "legacy prepack-via-size" rows
//     like RCB1510NPT/PPK18). Blank when PPK is in the style_code.
//
// Usage:  node scripts/export-ppk-audit.mjs [--out path.csv]
// Reads SUPABASE URL/KEY the same way download-item-master.mjs does.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env.local");
const PAGE_SIZE = 1000;
// Strict pattern (PPK followed by digits) — matches the backfill SQL
// in 20260517220000_item_master_pack_size.sql. Used for the eligibility
// filter so we only surface rows whose pack_size came from a real
// PPKn token.
const PPK_RE_WITH_DIGITS = /PPK\d+/i;
// Loose pattern (just "PPK" anywhere). Real-world Xoro style codes
// often carry the bare token "PPK" (RBB1258PPK, ACMB0016PPK, …) with
// the actual pack count only living in the size column. The planner
// audit wants "did style itself carry the PPK marker?" — that's the
// substring check, not the strict digit check.
const PPK_RE_LOOSE = /PPK/i;

async function loadEnv() {
  const raw = await readFile(ENV_PATH, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE URL / KEY in .env.local");
  return { url: url.replace(/\/$/, ""), key };
}

async function fetchPage(url, key, offset, limit) {
  // pack_size>1 narrows the fetch to ~few hundred rows max — the migration
  // built a partial index for exactly this query shape.
  const u = `${url}/rest/v1/ip_item_master?select=sku_code,style_code,color,size,description,pack_size&pack_size=gt.1&order=style_code.asc&offset=${offset}&limit=${limit}`;
  const r = await fetch(u, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const today = new Date().toISOString().slice(0, 10);
  const outPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : `ppk-audit-${today}.csv`;

  const { url, key } = await loadEnv();
  process.stdout.write(`Connecting to ${url}…\n`);

  const all = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage(url, key, offset, PAGE_SIZE);
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  process.stdout.write(`Fetched ${all.length} rows with pack_size > 1\n`);

  // Keep only rows where the PPK token shows up in style_code OR size.
  // Loose substring check so style codes like RBB1258PPK (bare token,
  // no digit suffix) count as "style-PPK". Excludes sku_code-only
  // matches per the audit ask.
  const eligible = all.filter((r) => PPK_RE_LOOSE.test(r.style_code ?? "") || PPK_RE_WITH_DIGITS.test(r.size ?? ""));
  process.stdout.write(`  ${eligible.length} match style/size PPK pattern (others dropped)\n`);

  // Group by (style_code, pack_size). Each group surfaces one example row.
  const byKey = new Map();
  for (const r of eligible) {
    const key = `${r.style_code ?? ""}|${r.pack_size}`;
    if (byKey.has(key)) continue;
    const styleHasPpk = PPK_RE_LOOSE.test(r.style_code ?? "");
    const sizeHasPpk = PPK_RE_WITH_DIGITS.test(r.size ?? "");
    byKey.set(key, {
      BasePart: r.style_code ?? "",
      Description: r.description ?? "",
      PPKQty: r.pack_size,
      // Show the size only when PPK came from there AND style didn't
      // carry the marker — these are the audit-worthy "legacy
      // prepack-via-size" rows (RCB1510NPT, RBB1439NFL, …). For
      // style-PPK rows the size variants are noise.
      SizeExample: sizeHasPpk && !styleHasPpk ? (r.size ?? "") : "",
    });
  }

  const rows = Array.from(byKey.values()).sort((a, b) => a.BasePart.localeCompare(b.BasePart));
  process.stdout.write(`  ${rows.length} unique (style, pack_size) pairs\n`);

  const header = ["BasePart", "Description", "PPKQty", "SizeExample"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((h) => csvCell(row[h])).join(","));
  }
  await writeFile(outPath, lines.join("\r\n") + "\r\n", "utf8");
  process.stdout.write(`Wrote ${outPath}\n`);
}

main().catch((e) => {
  process.stderr.write(`ERROR: ${e.message}\n`);
  process.exit(1);
});
