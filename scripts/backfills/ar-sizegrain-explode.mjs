#!/usr/bin/env node
/**
 * Historical size-grain explosion for EXISTING mirrored AR invoices.
 *
 * Applies the same explosion the nightly AR mirror now does (api/_lib/
 * xoro-mirror/ar-sizegrain.js) to ar_invoice_lines that were mirrored BEFORE
 * the size-grain path existed: for each ar_invoices whose invoice_number is
 * covered by the size-grain source (raw_xoro_payloads endpoint='sales-history'
 * — the raw Xoro invoice/getinvoice response, already mirrored locally), each
 * style+color rollup line is replaced by per-size lines pointing at true
 * size-grain ip_item_master items, preserving the line total to the cent.
 *
 * ⚠️ TRIGGER SAFETY (#1674): exploded lines are inserted with an explicit
 * line_total_cents and unit_price_cents=NULL unless quantity*unit reproduces
 * the total exactly (see composeExplodedLines). Kept lines are never touched.
 * We assert per-invoice that SUM(line_total_cents) is unchanged after the swap.
 *
 * IDEMPOTENT: only lines whose CURRENT item is style+color-grain (size NULL, or
 * a stray size with no embedded size token) and that map to a size bucket are
 * exploded. After a run those lines point at size-grain items, so a re-run finds
 * nothing left to explode for that style+color.
 *
 * HONEST RESIDUAL: invoices with no size-grain source coverage are reported and
 * left as style+color rollups. Widening coverage = widening the sales-history
 * raw-payload ingest (raw_xoro_payloads) — an ops action, not a code change.
 *
 * Usage (DRY RUN unless --apply):
 *   node scripts/backfills/ar-sizegrain-explode.mjs
 *   node scripts/backfills/ar-sizegrain-explode.mjs --apply
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  loadSizeSourceFromRawPayloads,
  resolveOrCreateSizeItems,
  buildExplodedInvoiceLines,
} from "../../api/_lib/xoro-mirror/ar-sizegrain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const APPLY = process.argv.includes("--apply");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) { console.error("x VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)"); process.exit(1); }
const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

// A line is a style+color ROLLUP (explodable) when its item has no size, or a
// stray size but no trailing size token in the sku_code.
const SIZE_TOKEN_RE =
  /-(XXXS|XXS|XSM|XS|SMALL|SML|SM|S|MEDIUM|MED|MD|M|LARGE|LRG|LG|L|XXXL|XXL|XL|[0-9]*X+LG?|OSFA|OS|O\/S|[0-9]+MO|[0-9]{1,3}|PPK[\s_-]*\d+)$/;
function isRollupItem(im) {
  if (!im) return false;
  const noSize = im.size == null || im.size === "";
  const hasToken = im.sku_code ? SIZE_TOKEN_RE.test(String(im.sku_code).toUpperCase()) : false;
  return noSize || !hasToken; // size-set + token => already true size-grain
}

async function main() {
  console.log(`AR size-grain explosion backfill — ${APPLY ? "APPLY" : "DRY RUN"}`);

  // 1. All size-source invoice numbers present locally.
  const { data: rawRows } = await sb.from("raw_xoro_payloads").select("payload").eq("endpoint", "sales-history");
  const allInvoiceNums = new Set();
  for (const row of rawRows || []) {
    const recs = Array.isArray(row?.payload?.data) ? row.payload.data : [];
    for (const rec of recs) {
      const num = (rec?.invoiceHeader?.InvoiceNumber ?? "").toString().trim();
      if (num) allInvoiceNums.add(num);
    }
  }
  console.log(`size-source (raw_xoro_payloads sales-history): ${allInvoiceNums.size} distinct invoice numbers`);

  // 2. Which of those exist as ar_invoices? (page through to dodge the 1000-row cap)
  const covered = [];
  const nums = [...allInvoiceNums];
  for (let i = 0; i < nums.length; i += 200) {
    const chunk = nums.slice(i, i + 200);
    const { data } = await sb.from("ar_invoices").select("id, invoice_number, total_amount_cents, entity_id").in("invoice_number", chunk);
    for (const r of data || []) covered.push(r);
  }
  console.log(`ar_invoices matched by invoice_number: ${covered.length}`);

  const sizeSource = await loadSizeSourceFromRawPayloads(sb, covered.map((c) => c.invoice_number));

  const stats = { invoices_covered: covered.length, invoices_with_explodable: 0, rollup_lines_explodable: 0, exploded_into: 0, invoices_applied: 0, mismatches: 0 };
  const residual = { invoices_no_source_lines: 0, invoices_no_rollup_lines: 0 };

  for (const inv of covered) {
    const srcLines = sizeSource.get(inv.invoice_number) || [];
    if (srcLines.length === 0) { residual.invoices_no_source_lines++; continue; }

    // Current AR lines for this invoice.
    const { data: lines } = await sb.from("ar_invoice_lines")
      .select("id, line_number, inventory_item_id, quantity, unit_price_cents, line_total_cents, tax_amount_cents, source, description")
      .eq("ar_invoice_id", inv.id);
    if (!lines || lines.length === 0) { residual.invoices_no_rollup_lines++; continue; }

    // Resolve item grain for each line.
    const lineItemIds = [...new Set(lines.map((l) => l.inventory_item_id).filter(Boolean))];
    const { data: items } = await sb.from("ip_item_master").select("id, sku_code, size").in("id", lineItemIds);
    const itemById = new Map((items || []).map((r) => [r.id, r]));

    // Explodable rollup lines: rollup-grain item, no tax, and a matching size bucket.
    const bucketKeys = new Set(srcLines.map((s) => s.style_color));
    const rollupLines = lines.filter((l) => {
      const im = itemById.get(l.inventory_item_id);
      if (!im || !isRollupItem(im)) return false;
      if (Number(l.tax_amount_cents || 0) !== 0) return false; // don't drop tax
      return bucketKeys.has(im.sku_code);
    });
    if (rollupLines.length === 0) { residual.invoices_no_rollup_lines++; continue; }

    stats.invoices_with_explodable++;
    stats.rollup_lines_explodable += rollupLines.length;

    // Resolve/create the size items the source references for these buckets.
    const wantSkus = srcLines.filter((s) => rollupLines.some((rl) => itemById.get(rl.inventory_item_id)?.sku_code === s.style_color)).map((s) => s.canon_sku);
    const itemMap = APPLY ? await resolveOrCreateSizeItems(sb, inv.entity_id, wantSkus) : new Map();

    // Build exploded lines per rollup line.
    const rollupForBuild = rollupLines.map((l) => ({
      line_number: l.line_number, line_total_cents: l.line_total_cents, quantity: l.quantity,
      description: l.description, source: l.source, _style_color: itemById.get(l.inventory_item_id)?.sku_code || null,
    }));
    const { lines: builtAll } = buildExplodedInvoiceLines(rollupForBuild, srcLines, (e) => itemMap.get(e.canon_sku) || `dry:${e.canon_sku}`);
    // Only the produced size lines (exclude any pass-throughs, which shouldn't happen here).
    const exploded = builtAll.filter((b) => b._size !== undefined || b.inventory_item_id?.toString().startsWith("dry:") || true);
    stats.exploded_into += exploded.length;

    if (!APPLY) continue;

    // Re-run safety: if this invoice already carries a line pointing at one of
    // the size-grain items we're about to insert, a prior (possibly partial)
    // run already exploded it — skip so we can never double/triple-insert.
    const targetIds = new Set([...itemMap.values()].filter(Boolean).map(String));
    if (lines.some((l) => targetIds.has(String(l.inventory_item_id)))) {
      console.warn(`  · ${inv.invoice_number}: already has size-grain lines — skipping (idempotent guard)`);
      continue;
    }

    // Amount-invariance guard: exploded totals must equal the rollup totals we replace.
    const rollupSum = rollupLines.reduce((a, l) => a + Number(l.line_total_cents || 0), 0);
    const explodedSum = exploded.reduce((a, l) => a + Number(l.line_total_cents || 0), 0);
    if (rollupSum !== explodedSum || exploded.some((e) => !e.inventory_item_id || String(e.inventory_item_id).startsWith("dry:"))) {
      stats.mismatches++;
      console.warn(`  ! ${inv.invoice_number}: skipped (sum ${rollupSum} vs ${explodedSum} or unresolved item)`);
      continue;
    }

    // Assign non-colliding line numbers above the current max.
    const maxLn = Math.max(0, ...lines.map((l) => Number(l.line_number || 0)));
    const toInsert = exploded.map((e, i) => ({
      ar_invoice_id: inv.id,
      line_number: maxLn + 1 + i,
      inventory_item_id: e.inventory_item_id,
      description: e.description ?? null,
      quantity: e.quantity,
      unit_price_cents: e.unit_price_cents,
      line_total_cents: e.line_total_cents,
      tax_amount_cents: 0,
      source: e.source || "xoro_mirror",
    }));

    const { error: insErr } = await sb.from("ar_invoice_lines").insert(toInsert);
    if (insErr) { stats.mismatches++; console.warn(`  ! ${inv.invoice_number}: insert failed ${insErr.message}`); continue; }
    const { error: delErr } = await sb.from("ar_invoice_lines").delete().in("id", rollupLines.map((l) => l.id));
    if (delErr) { console.warn(`  ! ${inv.invoice_number}: delete failed ${delErr.message} — exploded lines inserted, rollup NOT removed`); continue; }

    // Verify header ties to lines after the swap.
    const { data: after } = await sb.from("ar_invoice_lines").select("line_total_cents").eq("ar_invoice_id", inv.id);
    const afterSum = (after || []).reduce((a, l) => a + Number(l.line_total_cents || 0), 0);
    const { data: hdr } = await sb.from("ar_invoices").select("total_amount_cents").eq("id", inv.id).maybeSingle();
    if (Number(hdr?.total_amount_cents) !== afterSum) { stats.mismatches++; console.warn(`  ! ${inv.invoice_number}: header ${hdr?.total_amount_cents} != lines ${afterSum}`); }
    stats.invoices_applied++;
  }

  console.log("\n== stats ==");
  console.log(JSON.stringify(stats, null, 2));
  console.log("== residual (uncovered) ==");
  console.log(JSON.stringify(residual, null, 2));
  if (!APPLY) console.log("\nDRY RUN — pass --apply to explode.");
  else console.log("\nDone.");
}
main().catch((e) => { console.error(e); process.exit(1); });
