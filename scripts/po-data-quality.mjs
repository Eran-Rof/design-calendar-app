#!/usr/bin/env node
// PO DATA-QUALITY REPORT (read-only). Prints every catalog/link defect on ACTIVE
// native POs from the v_po_data_quality view — the same findings the PO grid's
// "⚠ Data quality" report and per-PO badge show — so bad imports are never silent.
//
//   node scripts/po-data-quality.mjs           # grouped detail + summary
//   node scripts/po-data-quality.mjs --errors  # exit nonzero only if ERRORS exist
//
// Reads PROD via the Supabase Management API (SUPABASE_PAT from .env.local /
// .env.staging). Exit 0 = clean (or warnings-only unless a red bucket).
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(f) {
  try {
    const t = readFileSync(resolve(ROOT, f), "utf8");
    return Object.fromEntries(t.split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!PAT) { console.error("✗ SUPABASE_PAT missing"); process.exit(1); }
const PROD = "qcvqvxxoperiurauoxmp";
async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROD}/database/query`,
    { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`SQL ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

const LABEL = {
  orphan_style_code: "Orphan style code (not in catalog) → 'Style not found'",
  unlinked_line: "Unlinked line (no SKU) → no cost/sell/matrix",
  ppk_no_prepack_def: "PPK style missing prepack definition → blank / wrong explode",
  incomplete_size_coverage: "Incomplete size coverage → 'most in one size'",
};
const ERRORS_ONLY = process.argv.includes("--errors");

const rows = await q(`select po_number, defect_class, severity, style_code, color, suggested_fix, item_count
  from v_po_data_quality order by severity, defect_class, po_number`);

console.log(`\n  PO DATA-QUALITY REPORT — ${rows.length} finding(s) on active POs\n`);
const classes = [...new Set(rows.map((r) => r.defect_class))];
let errors = 0;
for (const cls of classes) {
  const g = rows.filter((r) => r.defect_class === cls);
  const isErr = g.some((r) => r.severity === "error");
  if (isErr) errors += g.length;
  console.log(`${isErr ? "🔴" : "🟡"} ${LABEL[cls] || cls} — ${g.length} finding(s), ${new Set(g.map((r) => r.po_number)).size} PO(s)`);
  for (const r of g.slice(0, 12)) console.log(`      ${r.po_number}  ${r.style_code || ""}${r.color ? " / " + r.color : ""}  ×${r.item_count}  → ${r.suggested_fix}`);
  if (g.length > 12) console.log(`      … +${g.length - 12} more`);
  console.log("");
}
console.log(`── SUMMARY ──────────────────────────────────────`);
console.log(`  ${errors} error(s), ${rows.length - errors} warning(s) across ${new Set(rows.map((r) => r.po_number)).size} active PO(s).`);
console.log(rows.length ? `  See the PO grid → "⚠ Data quality" report for the same detail + xlsx export.\n` : `  ✓ No data-quality issues on active POs.\n`);
process.exit((ERRORS_ONLY ? errors : rows.length) ? 1 : 0);
