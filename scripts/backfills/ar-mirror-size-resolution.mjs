#!/usr/bin/env node
/**
 * AR-mirror size-resolution diagnostic + backfill.
 *
 * WHY: AR invoice lines mirrored from Xoro (source='xoro_mirror') and the AR
 * history backfill (source='manual') both take their inventory_item_id from
 * ip_sales_history_wholesale.sku_id, which is a STYLE+COLOR-grain planning key
 * (the Excel sales ingest strips size and aggregates). So AR lines inherit
 * style+color-grain items, and the color x size matrix in the AR invoice
 * expander either:
 *   - lumps ALL qty into one stray size cell  (rollup item carries a stray size), or
 *   - drops the line to the non-matrix "other lines" bucket  (rollup item size IS NULL).
 *
 * This script does NOT touch ar_invoice_lines (so it can never trip the
 * ar_invoice_lines_compute_total_trg NET->GROSS clobber, #1674). It only
 * corrects ip_item_master.size, which every AR/RMA line resolves through.
 *
 * MODES (DRY RUN unless --apply is passed):
 *   (default / --report)  Print the AR-line class breakdown + item counts.
 *   --parse-sizes         SAFE. Populate ip_item_master.size from a trailing
 *                         size token in the sku_code (e.g. "...-LARGE" -> LARGE)
 *                         for rows where size IS NULL. Turns those AR lines into
 *                         REAL matrix cells. Fully reversible (all touched rows
 *                         had size NULL; re-null to revert). Mirrors the
 *                         SIZE_TOKEN_RE vocabulary in api/_lib/sku-canon.js.
 *   --null-stray-sizes    GATED (needs operator sign-off). NULL the stray size
 *                         on multi-size style+color ROLLUP rows (sku_code has no
 *                         trailing size token, size populated, and a distinct
 *                         sized variant of the same style+color exists). Stops
 *                         the "all qty lumped into one size" lie; the line then
 *                         renders as an honest style+color aggregate. This
 *                         mutates shared master rows read by planning too, so it
 *                         is intentionally NOT part of the default run.
 *
 * Usage:
 *   node scripts/backfills/ar-mirror-size-resolution.mjs                 # report only (dry)
 *   node scripts/backfills/ar-mirror-size-resolution.mjs --parse-sizes   # preview parse-sizes (dry)
 *   node scripts/backfills/ar-mirror-size-resolution.mjs --parse-sizes --apply
 *   node scripts/backfills/ar-mirror-size-resolution.mjs --null-stray-sizes --apply   # operator-gated
 *
 * Runs against PROD via the Supabase Management API (same SUPABASE_PAT pattern
 * as scripts/run-sql-prod.mjs).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const PROD_REF = "qcvqvxxoperiurauoxmp";

const APPLY = process.argv.includes("--apply");
const DO_PARSE = process.argv.includes("--parse-sizes");
const DO_STRAY = process.argv.includes("--null-stray-sizes");

// Trailing size-token vocabulary — POSIX mirror of SIZE_TOKEN_RE in
// api/_lib/sku-canon.js (\s -> [ _-], otherwise identical set).
const SIZE_TOKEN =
  "-(XXXS|XXS|XSM|XS|SMALL|SML|SM|S|MEDIUM|MED|MD|M|LARGE|LRG|LG|L|XXXL|XXL|XL|[0-9]*X+LG?|OSFA|OS|O/S|[0-9]+MO|[0-9]{1,3}|PPK[ _-]*[0-9]+)$";

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(
      text.split("\n")
        .filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
    );
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!PAT) { console.error("x SUPABASE_PAT missing (.env.local)"); process.exit(1); }

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`SQL ${res.status}: ${text}`); throw new Error(`query failed (${res.status})`); }
  try { return JSON.parse(text); } catch { return text; }
}

const table = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) { console.log("  (no rows)"); return; }
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  console.log("  " + cols.map((c, i) => c.padEnd(w[i])).join("  "));
  for (const r of rows) console.log("  " + cols.map((c, i) => String(r[c] ?? "").padEnd(w[i])).join("  "));
};

async function report() {
  console.log("\n== AR invoice line class breakdown (by source) ==");
  const cls = await q(`
    WITH c AS (
      SELECT ail.source,
        CASE
          WHEN ail.inventory_item_id IS NULL THEN 'null_item'
          WHEN im.size IS NULL OR im.size='' THEN 'nullsize_rollup(non-matrix)'
          WHEN im.sku_code ~ '${SIZE_TOKEN}' THEN 'true_size_grain'
          ELSE 'straysize_rollup(lumped-1-size)'
        END AS klass
      FROM ar_invoice_lines ail
      LEFT JOIN ip_item_master im ON im.id = ail.inventory_item_id)
    SELECT source, klass, count(*) AS lines FROM c GROUP BY 1,2 ORDER BY 1, 3 DESC;`);
  table(cls);

  console.log("\n== --parse-sizes scope: null-size items whose sku_code embeds a size token ==");
  const parse = await q(`
    SELECT count(*) AS items,
      (SELECT count(*) FROM ar_invoice_lines ail JOIN ip_item_master im ON im.id=ail.inventory_item_id
        WHERE (im.size IS NULL OR im.size='') AND im.sku_code ~ '${SIZE_TOKEN}') AS ar_lines_fixed
    FROM ip_item_master
    WHERE (size IS NULL OR size='') AND sku_code ~ '${SIZE_TOKEN}';`);
  table(parse);

  console.log("\n== --null-stray-sizes scope: multi-size rollup rows carrying a stray size ==");
  const stray = await q(`
    WITH rollup AS (
      SELECT r.id, r.style_code, r.color
      FROM ip_item_master r
      WHERE r.size IS NOT NULL AND r.size<>'' AND r.sku_code LIKE '%-%'
        AND r.sku_code !~ '${SIZE_TOKEN}')
    SELECT count(*) AS rollup_items_with_stray_size,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM ip_item_master v
        WHERE v.style_code=rollup.style_code AND COALESCE(v.color,'')=COALESCE(rollup.color,'')
          AND v.id<>rollup.id AND v.size IS NOT NULL AND v.size<>'')) AS with_true_sized_variant
    FROM rollup;`);
  table(stray);
}

// Collision guard: setting size populates the logical-SKU unique key
// (entity_id, style_id, color, canonical_size(size), inseam). Some null-size
// rows are DUPLICATE fragments of an already-sized twin (e.g. "...-FALCON-SML"
// vs an existing "...-FALCON-S" whose canonical_size is also SMALL). Writing
// the size there would violate uq_ip_item_master_logical_sku. We skip those —
// the correct remedy (re-point the AR line at the twin / merge the fragment)
// touches ar_invoice_lines and needs its own operator-signed pass. This guard
// keeps parse-sizes to the genuinely NEW size-grain rows.
const NO_COLLISION = `NOT EXISTS (
    SELECT 1 FROM ip_item_master x
    WHERE x.id <> m.id
      AND x.entity_id = m.entity_id
      AND x.style_id IS NOT DISTINCT FROM m.style_id
      AND COALESCE(x.color,'') = COALESCE(m.color,'')
      AND COALESCE(x.inseam,'') = COALESCE(m.inseam,'')
      AND canonical_size(x.size) = canonical_size(substring(m.sku_code from '${SIZE_TOKEN}')))`;

async function parseSizes() {
  const preview = await q(`
    SELECT
      count(*) AS matched,
      count(*) FILTER (WHERE ${NO_COLLISION}) AS will_update,
      count(*) FILTER (WHERE NOT (${NO_COLLISION})) AS skip_collision
    FROM ip_item_master m
    WHERE (m.size IS NULL OR m.size='') AND m.sku_code ~ '${SIZE_TOKEN}';`);
  console.log(`\n[--parse-sizes] matched=${preview[0].matched}  will_update=${preview[0].will_update}  skip_collision=${preview[0].skip_collision} (duplicate fragments of an existing sized twin — operator follow-up).`);
  const sample = await q(`
    SELECT sku_code, substring(sku_code from '${SIZE_TOKEN}') AS new_size FROM ip_item_master m
    WHERE (m.size IS NULL OR m.size='') AND m.sku_code ~ '${SIZE_TOKEN}' AND ${NO_COLLISION}
    ORDER BY sku_code LIMIT 12;`);
  console.log("  sample (will update):"); table(sample);
  if (!APPLY) { console.log("  DRY RUN — pass --apply to write."); return; }
  const upd = await q(`
    UPDATE ip_item_master m
    SET size = substring(m.sku_code from '${SIZE_TOKEN}')
    WHERE (m.size IS NULL OR m.size='') AND m.sku_code ~ '${SIZE_TOKEN}' AND ${NO_COLLISION}
    RETURNING id;`);
  console.log(`  APPLIED — populated size on ${Array.isArray(upd) ? upd.length : "?"} items.`);
}

async function nullStraySizes() {
  const preview = await q(`
    WITH rollup AS (
      SELECT r.id FROM ip_item_master r
      WHERE r.size IS NOT NULL AND r.size<>'' AND r.sku_code LIKE '%-%' AND r.sku_code !~ '${SIZE_TOKEN}'
        AND EXISTS (SELECT 1 FROM ip_item_master v
          WHERE v.style_code=r.style_code AND COALESCE(v.color,'')=COALESCE(r.color,'')
            AND v.id<>r.id AND v.size IS NOT NULL AND v.size<>''))
    SELECT count(*) AS to_null FROM rollup;`);
  console.log(`\n[--null-stray-sizes] ${preview[0].to_null} multi-size rollup rows carry a stray size (true variant exists).`);
  console.log("  NOTE: this converts 'lumped into one size' -> honest 'non-matrix aggregate'. Operator sign-off required.");
  if (!APPLY) { console.log("  DRY RUN — pass --apply to write."); return; }
  const upd = await q(`
    UPDATE ip_item_master r SET size = NULL
    WHERE r.size IS NOT NULL AND r.size<>'' AND r.sku_code LIKE '%-%' AND r.sku_code !~ '${SIZE_TOKEN}'
      AND EXISTS (SELECT 1 FROM ip_item_master v
        WHERE v.style_code=r.style_code AND COALESCE(v.color,'')=COALESCE(r.color,'')
          AND v.id<>r.id AND v.size IS NOT NULL AND v.size<>'')
    RETURNING id;`);
  console.log(`  APPLIED — nulled stray size on ${Array.isArray(upd) ? upd.length : "?"} rollup items.`);
}

(async () => {
  console.log(`AR-mirror size resolution — ${APPLY ? "APPLY" : "DRY RUN"} (prod ${PROD_REF})`);
  await report();
  if (DO_PARSE) await parseSizes();
  if (DO_STRAY) await nullStraySizes();
  if (!DO_PARSE && !DO_STRAY) console.log("\n(no mutation flag — report only. Use --parse-sizes and/or --null-stray-sizes.)");
  console.log("\nDone.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
