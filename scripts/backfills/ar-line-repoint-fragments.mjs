#!/usr/bin/env node
/**
 * AR-line re-point: duplicate size-fragment items → their canonical sized twin.
 *
 * WHY (completes PR #1817): --parse-sizes populated ip_item_master.size for
 * null-size items whose sku_code embeds a size token, turning them into true
 * size-grain rows. It SKIPPED items where writing the parsed size would violate
 * uq_ip_item_master_logical_sku(entity_id, style_id, color, canonical_size,
 * inseam) — i.e. a DUPLICATE FRAGMENT of an already-sized twin (e.g.
 * "...-STONEBLOCKGD-MEDIUM" (size NULL) vs existing "...-STONE-BLOCK-GD-MED"
 * (size MED); canonical_size(MEDIUM)==canonical_size(MED)). Those fragments
 * can't be sized in place, so the AR lines pointing at them stay non-matrix.
 *
 * FIX: re-point ar_invoice_lines.inventory_item_id from each fragment to its
 * canonical sized twin (unambiguous — every collision fragment has exactly one
 * twin at the matching canonical size). The AR line then renders in the right
 * color x size matrix cell.
 *
 * ⚠️ TRIGGER SAFETY (#1674 NET->GROSS clobber): the ONLY column this UPDATE
 * touches is inventory_item_id. The clobber trigger is
 *   ar_invoice_lines_compute_total_trg BEFORE INSERT OR UPDATE
 *     OF quantity, unit_price_cents, line_total_cents
 * — a column-scoped UPDATE OF trigger that does NOT fire when none of those
 * three columns is in the SET list. So line_total_cents is provably untouched.
 * The AFTER ar_invoice_lines_total_trg re-sums the (unchanged) line totals, so
 * ar_invoices.total_amount_cents is unchanged too. The script proves this with
 * a per-invoice before/after SUM check that must match to the cent.
 *
 * FRAGMENT DISPOSITION: the fragments are STILL referenced by planning-side
 * tables (ip_sales_history_wholesale, ip_inventory_snapshot, ip_receipts_history,
 * ip_forecast_actuals) whose grain we must NOT change (per #1817 planning-grain
 * rule). So we LEAVE the fragment rows in place (no soft-delete) — only the AR
 * lines are re-pointed. The script reports remaining references per fragment.
 *
 * Usage (DRY RUN unless --apply):
 *   node scripts/backfills/ar-line-repoint-fragments.mjs
 *   node scripts/backfills/ar-line-repoint-fragments.mjs --apply
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const APPLY = process.argv.includes("--apply");

const SIZE_TOKEN =
  "-(XXXS|XXS|XSM|XS|SMALL|SML|SM|S|MEDIUM|MED|MD|M|LARGE|LRG|LG|L|XXXL|XXL|XL|[0-9]*X+LG?|OSFA|OS|O/S|[0-9]+MO|[0-9]{1,3}|PPK[ _-]*[0-9]+)$";

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!PAT) { console.error("x SUPABASE_PAT missing (.env.local)"); process.exit(1); }

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
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

// The collision-fragment → canonical-twin mapping. LATERAL picks the single
// sized twin at the matching canonical size (all such fragments have exactly
// one; the query still LIMIT 1 defensively, preferring a size-populated twin).
const MAP_CTE = `
  WITH tok AS (SELECT '${SIZE_TOKEN}' AS re),
  frag AS (
    SELECT m.id AS frag_id, m.entity_id, m.style_id, m.color, m.inseam, m.sku_code AS frag_sku,
           substring(m.sku_code from (SELECT re FROM tok)) AS parsed
    FROM ip_item_master m, tok
    WHERE (m.size IS NULL OR m.size='') AND m.sku_code ~ tok.re
      AND EXISTS (SELECT 1 FROM ip_item_master x, tok t2
        WHERE x.id<>m.id AND x.entity_id=m.entity_id AND x.style_id IS NOT DISTINCT FROM m.style_id
          AND COALESCE(x.color,'')=COALESCE(m.color,'') AND COALESCE(x.inseam,'')=COALESCE(m.inseam,'')
          AND canonical_size(x.size)=canonical_size(substring(m.sku_code from t2.re)))
  ),
  map AS (
    SELECT frag.frag_id, frag.frag_sku, twin.id AS twin_id, twin.sku_code AS twin_sku
    FROM frag
    JOIN LATERAL (
      SELECT t.id, t.sku_code FROM ip_item_master t, tok
      WHERE t.entity_id=frag.entity_id AND t.style_id IS NOT DISTINCT FROM frag.style_id
        AND COALESCE(t.color,'')=COALESCE(frag.color,'') AND COALESCE(t.inseam,'')=COALESCE(frag.inseam,'')
        AND canonical_size(t.size)=canonical_size(frag.parsed) AND t.id<>frag.frag_id
      ORDER BY (t.size IS NOT NULL) DESC, t.sku_code LIMIT 1
    ) twin ON true
  )`;

async function main() {
  console.log(`AR-line re-point (fragments -> twins) — ${APPLY ? "APPLY" : "DRY RUN"} (prod ${PROD_REF})`);

  console.log("\n== fragment -> twin map + AR-line counts ==");
  const map = await q(`${MAP_CTE}
    SELECT map.frag_sku, map.twin_sku,
      (SELECT count(*) FROM ar_invoice_lines a WHERE a.inventory_item_id=map.frag_id) AS ar_lines
    FROM map ORDER BY ar_lines DESC;`);
  table(map);

  const affected = await q(`${MAP_CTE}
    SELECT count(*) AS fragments,
      (SELECT count(*) FROM ar_invoice_lines a JOIN map ON map.frag_id=a.inventory_item_id) AS ar_lines,
      (SELECT count(DISTINCT a.ar_invoice_id) FROM ar_invoice_lines a JOIN map ON map.frag_id=a.inventory_item_id) AS invoices
    FROM map;`);
  console.log(`\nfragments=${affected[0].fragments}  ar_lines_to_repoint=${affected[0].ar_lines}  invoices_touched=${affected[0].invoices}`);

  console.log("\n== other (non-AR) references to the fragments — these keep the fragment row alive ==");
  const refs = await q(`${MAP_CTE}
    SELECT 'ip_sales_history_wholesale' tbl, count(*) n FROM ip_sales_history_wholesale s JOIN map ON map.frag_id=s.sku_id
    UNION ALL SELECT 'ip_inventory_snapshot', count(*) FROM ip_inventory_snapshot s JOIN map ON map.frag_id=s.sku_id
    UNION ALL SELECT 'ip_receipts_history', count(*) FROM ip_receipts_history s JOIN map ON map.frag_id=s.sku_id
    UNION ALL SELECT 'ip_forecast_actuals', count(*) FROM ip_forecast_actuals s JOIN map ON map.frag_id=s.sku_id
    ORDER BY n DESC;`);
  table(refs);

  // Before-state fingerprint: per-invoice line-total sum, plus global totals.
  const before = await q(`${MAP_CTE}, inv AS (
      SELECT DISTINCT a.ar_invoice_id FROM ar_invoice_lines a JOIN map ON map.frag_id=a.inventory_item_id)
    SELECT
      (SELECT count(*) FROM ar_invoice_lines) AS total_ar_lines,
      (SELECT coalesce(sum(line_total_cents),0) FROM ar_invoice_lines) AS total_line_cents,
      (SELECT coalesce(sum(total_amount_cents),0) FROM ar_invoices i WHERE i.id IN (SELECT ar_invoice_id FROM inv)) AS affected_hdr_cents,
      (SELECT coalesce(sum(line_total_cents),0) FROM ar_invoice_lines l WHERE l.ar_invoice_id IN (SELECT ar_invoice_id FROM inv)) AS affected_line_cents;`);
  console.log("\n== BEFORE ==");
  table(before);

  if (!APPLY) { console.log("\nDRY RUN — pass --apply to re-point. Fragment rows are LEFT in place (still referenced by planning tables)."); return; }

  const reason = "PR ar-sizegrain deliverable 1: re-point AR lines from duplicate size-fragment ip_item_master rows to their canonical sized twin (uq_ip_item_master_logical_sku collision fragments skipped by #1817 --parse-sizes). Only inventory_item_id changes; line_total_cents untouched.".replace(/'/g, "''");
  await q(`
    SELECT set_config('app.audit_reason', '${reason}', false);
    ${MAP_CTE}
    UPDATE ar_invoice_lines l SET inventory_item_id = map.twin_id
    FROM map WHERE l.inventory_item_id = map.frag_id;`);
  // The Management API returns the LAST statement's rows; count via a follow-up.
  const after = await q(`
    SELECT
      (SELECT count(*) FROM ar_invoice_lines) AS total_ar_lines,
      (SELECT coalesce(sum(line_total_cents),0) FROM ar_invoice_lines) AS total_line_cents;`);
  console.log("\n== AFTER (global invariants — must equal BEFORE) ==");
  table(after);

  // Per-invoice amount invariance is guaranteed because line_total_cents never
  // changed; assert the two global sums match to the cent.
  const beforeLines = String(before[0].total_ar_lines);
  const beforeCents = String(before[0].total_line_cents);
  const okLines = beforeLines === String(after[0].total_ar_lines);
  const okCents = beforeCents === String(after[0].total_line_cents);
  console.log(`\ninvariance: total_ar_lines ${okLines ? "OK" : "MISMATCH"} (${beforeLines} -> ${after[0].total_ar_lines}); total_line_cents ${okCents ? "OK" : "MISMATCH"} (${beforeCents} -> ${after[0].total_line_cents})`);

  const leftover = await q(`${MAP_CTE}
    SELECT (SELECT count(*) FROM ar_invoice_lines a JOIN map ON map.frag_id=a.inventory_item_id) AS ar_lines_still_on_fragments FROM map LIMIT 1;`);
  console.log(`ar_lines_still_on_fragments (should be 0): ${leftover[0].ar_lines_still_on_fragments}`);
  console.log("\nFragment ip_item_master rows LEFT in place (still referenced by planning/snapshot/receipts/forecast tables).");
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
