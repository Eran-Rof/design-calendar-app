// Client-side Excel ingest for planning data. Used as the manual fallback
// when the Xoro API isn't wired up (e.g. invoices/sales-history endpoint
// not provisioned on the customer's Xoro account).
//
// Two flows:
//   ingestSalesExcel(file)      — sales history → ip_sales_history_wholesale
//   ingestItemMasterExcel(file) — authoritative SKU/style/color/desc/avgCost
//
// Parsing happens in the browser via xlsx; persistence is direct Supabase
// REST upsert so we don't pay another serverless cold start.

import * as XLSX from "xlsx";
import { SB_HEADERS, SB_URL } from "../../utils/supabase";
import { wholesaleRepo } from "./wholesalePlanningRepository";
import { canonSku as sharedCanonSku, canonStyleColor } from "../utils/skuCanon";
import { extractPpk } from "../../shared/prepack";

export interface ExcelIngestResult {
  parsed: number;
  inserted: number;
  skipped_no_sku: number;
  skipped_no_date: number;
  skipped_zero_qty: number;
  skipped_bad_cost: number;
  // Rows collapsed because their identifying key was already seen
  // earlier in the same upload. Master ingest dedupes on (style,
  // color); Xoro exports often have one row per (style, color, size)
  // variant, so multiple sizes of the same color collapse here.
  // Counting them so the upload-summary modal accounts for every
  // parsed row (rows_read = rows_saved + skipped_*).
  skipped_duplicate: number;
  // Number of variant-grain rows (one per unique style + color +
  // size) written to ip_item_master alongside the rolled-up
  // (style, color) rows. Variants live in the same table marked by
  // size IS NOT NULL — invisible to the planning grid (forecasts
  // only point at rolled-up sku_ids), used by the future PO builder
  // to assemble Xoro-shape line items at the full SKU grain.
  inserted_variants: number;
  // Excel rows that collided on the (style, color, size) variant
  // key with an already-recorded variant — true duplicates of the
  // same physical SKU in the source spreadsheet. Distinguished
  // from skipped_duplicate (which counts (style, color) collisions
  // for the rolled-up pass) so the math holds:
  //   parsed = inserted_variants + skipped_variant_duplicate
  //          + skipped_no_sku + (other skip buckets)
  skipped_variant_duplicate: number;
  // Full list of rolled-up SKUs whose Excel rows had no Size value
  // populated. Surfaced as a copy-to-clipboard list in the upload
  // modal so the planner can fix the source spreadsheet.
  no_size_skus: string[];
  // Groups of raw Excel rows that collided on the same canonical
  // (style, color, size) variant key. Surfaced in the upload modal
  // as a copy-as-TSV blob so the planner can paste into Excel and
  // see exactly which fields differ between the supposedly-duplicate
  // rows. Each group has the variant_key plus EVERY raw row that
  // mapped to it (the kept first occurrence + all subsequent
  // collisions). Only groups with rows.length > 1 are included.
  duplicate_variant_groups: Array<{
    variant_key: string;
    rows: Array<Record<string, unknown>>;
  }>;
  errors: string[];
  // Data-quality warnings raised at ingest time. Variant rows missing
  // identifying dimensions (color/size) are flagged here so the planner
  // sees the gap instead of letting the forecast service silently
  // backfill from style-master fallbacks (the bug that grouped 31
  // distinct colors of RYB0412 into one "Grey" bucket). Soft signal —
  // ingest still completes; the planner is expected to fix the master
  // upstream and re-import.
  warnings: string[];
  warning_counts?: {
    missing_color: number;
    missing_size: number;
    color_mismatches_skucode: number;
  };
}

const empty = (): ExcelIngestResult => ({
  parsed: 0, inserted: 0, skipped_no_sku: 0,
  skipped_no_date: 0, skipped_zero_qty: 0, skipped_bad_cost: 0,
  skipped_duplicate: 0, inserted_variants: 0,
  skipped_variant_duplicate: 0, no_size_skus: [],
  duplicate_variant_groups: [],
  errors: [],
  warnings: [],
});

// Local thin wrapper so existing call sites don't need renaming.
// Both delegate to the shared module so SKU normalization can't drift
// between Excel ingest and the API handlers (xoro-sales-sync,
// tanda-pos-sync, ats-supply-sync).
const canon = sharedCanonSku;
function stripSizeSuffix(s: string): string {
  return canonStyleColor(s);
}

// Derive the bare style code for a prepack row. Xoro CurrentProducts
// exports often bake the pack-size suffix into ItemNumber
// ("RYG1842PPK-BLACK-PPK60") even when BasePartNumber is the clean
// style on its own. Composing the rolled-up sku from raw ItemNumber
// then produced ugly keys like "RYG1842PPK-BLACK-PPK60" plus a
// variant-pass row with the color appended a second time
// ("RYG1842PPK-BLACK-PPK60-BLACK"), and ATS lookups missed them
// because Xoro emits the bare (style, color) form for the actual
// inventory row.
//
// Resolution order:
//   1. explicit BasePartNumber/Style column — already the bare style.
//   2. ItemNumber with the trailing "-PPKn" (and optional final
//      "-COLOR" tail) stripped, then keep the first dash-segment as
//      the style.
//   3. ItemNumber as-is — last resort.
//
// canon-output (uppercase, no whitespace) so it composes cleanly with
// canon(color) downstream.
function barePrepackStyle(explicitStyle: string, explicitSkuRaw: string): string {
  if (explicitStyle) return canon(explicitStyle);
  if (!explicitSkuRaw) return "";
  const stripped = explicitSkuRaw.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, "");
  const firstDash = stripped.indexOf("-");
  return canon(firstDash > 0 ? stripped.slice(0, firstDash) : stripped);
}

function toIsoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const d = v;
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    const p = XLSX.SSF.parse_date_code(v);
    if (!p) return null;
    const m = String(p.m).padStart(2, "0");
    const d = String(p.d).padStart(2, "0");
    return `${p.y}-${m}-${d}`;
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// Look up a value across multiple possible column name spellings, case-
// insensitive AND ignoring punctuation/whitespace differences. Excel
// templates use spaces, code uses underscores — normalize both so
// "Txn Date" / "txn_date" / "TXN-DATE" all match the same key.
// Also splits camelCase + letter↔digit boundaries so Xoro/Shopify-style
// PascalCase headers like "BasePartNumber" / "Option1Value" /
// "StandardUnitCost" match the spaced aliases.
function normHeader(s: string): string {
  return s.trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[\s_\-.]+/g, " ")
    .trim();
}
function pick(row: Record<string, unknown>, names: string[]): unknown {
  const lower = new Map(Object.entries(row).map(([k, v]) => [normHeader(k), v]));
  for (const n of names) {
    const v = lower.get(normHeader(n));
    if (v != null && v !== "") return v;
  }
  return null;
}

// Yield to the event loop so the browser can paint between
// JS-blocking phases. setTimeout(0) drops us to the back of the
// task queue; rAF would coalesce with the next paint frame either
// way. Without these yields, the upload modal's text + animation
// stay frozen until parse completes — the planner sees a dead UI
// for the whole 5–10s a 30k-row XLSX takes.
const yieldToBrowser = () => new Promise<void>((res) => setTimeout(res, 0));

async function parseWorkbook(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<Record<string, unknown>[]> {
  const sizeMb = (file.size / 1024 / 1024).toFixed(1);
  onProgress?.(`Opening file (${sizeMb} MB)…`);
  await yieldToBrowser();
  const buf = await file.arrayBuffer();

  onProgress?.(`Reading the spreadsheet (this can take a few seconds for big files)…`);
  await yieldToBrowser();

  // Run XLSX.read() + sheet_to_json() in a dedicated Web Worker.
  // Without this, those two calls block the main thread for ~5–10s
  // on a 32k-row file, which is long enough for Chrome to show the
  // "Page Unresponsive" dialog. The buffer is transferred (zero
  // copy) and the worker terminates as soon as it returns.
  const worker = new Worker(
    new URL("./excelParseWorker.ts", import.meta.url),
    { type: "module" },
  );
  const result = await new Promise<{ sheetName: string; rows: Array<Record<string, unknown>> }>((resolve, reject) => {
    worker.onmessage = (
      e: MessageEvent<
        | { ok: true; sheetName: string; rows: Array<Record<string, unknown>> }
        | { ok: false; error: string }
      >,
    ) => {
      if (e.data.ok) resolve({ sheetName: e.data.sheetName, rows: e.data.rows });
      else reject(new Error(e.data.error));
    };
    worker.onerror = (err) => {
      reject(new Error(err.message || "Excel parse worker crashed"));
    };
    // Transfer the ArrayBuffer to the worker so we don't pay the
    // structured-clone cost for a 5MB+ payload.
    worker.postMessage(buf, [buf]);
  }).finally(() => worker.terminate());

  onProgress?.(`Found ${result.rows.length.toLocaleString()} rows`);
  return result.rows;
}

async function sbPost(path: string, body: unknown[], prefer: string): Promise<void> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase POST ${path} failed: ${r.status} ${text}`);
  }
}

// ── Sales history ──────────────────────────────────────────────────────────
//
// Expected columns (case-insensitive; multiple aliases supported):
//   SKU              ("sku", "sku_code", "item_number", "item", "itemnumber")
//                    OR composite "Base Part Number" + "Option 1 Value"
//                    OR "Base Part Number" + "Option 1 Value" + "Option 2 Value"
//   Customer         ("customer", "customer_name", "customer_code", "account")
//   Date             ("date", "txn_date", "invoice_date", "ship_date", "order_date")
//   Qty              ("qty", "quantity", "total sum of qty", "qty_shipped", "qty_invoiced")
//   UnitPrice        ("unit_price", "unit price - 2", "price", "unitprice") — optional
//   InvoiceNumber    ("invoice_number", "invoice number", "invoice") — optional
//   OrderNumber      ("order_number", "order") — optional
//   Sale Store       ("sale_store", "sale store", "store") — optional, used to skip
//                    "Grand Total" summary rows + filter ecom

// Pulls out a SKU from a row at the **style+color** grain (size is
// intentionally dropped). Tries direct columns first, then composes
// from "Base Part Number" + "Option 1 Value" the way Xoro report
// exports lay it out. Multiple sizes of the same style+color are
// aggregated into a single row downstream.
function extractSku(r: Record<string, unknown>): string {
  // Direct SKU column: strip size suffix to align with style+color grain.
  const direct = canon(pick(r, ["sku", "sku_code", "item_number", "itemnumber", "item"]) as string);
  if (direct) return stripSizeSuffix(direct);
  const base = String(pick(r, ["base_part_number", "base part number", "base_part", "style_code", "style"]) ?? "").trim();
  if (!base) return "";
  const opt1 = String(pick(r, ["option_1_value", "option 1 value", "color", "colour"]) ?? "").trim();
  const parts = [base, opt1].filter(Boolean);
  return canon(parts.join("-"));
}

export async function ingestSalesExcel(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<ExcelIngestResult> {
  // Two-channel logger: console gets the full technical detail (kept
  // for debugging via the [excel-sales] prefix); the status bar shown
  // to the planner gets the friendly version. When `friendly` is
  // omitted, both go to the technical line.
  const log = (m: string, friendly?: string) => {
    console.log("[excel-sales]", m);
    onProgress?.(friendly ?? m);
  };
  const result = empty();
  log(
    `Parsing ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`,
    `Reading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`,
  );
  const rows = await parseWorkbook(file, onProgress);
  result.parsed = rows.length;
  log(`Parsed ${rows.length.toLocaleString()} rows`, `Found ${rows.length.toLocaleString()} rows in the file`);
  if (rows.length === 0) return result;

  log("Loading item + customer masters…", "Looking up existing items and customers…");
  const [items, customers] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listCustomers(),
  ]);
  log(
    `Masters loaded: ${items.length.toLocaleString()} items, ${customers.length.toLocaleString()} customers`,
    `Found ${items.length.toLocaleString()} existing items and ${customers.length.toLocaleString()} customers`,
  );
  const skuToId = new Map(items.map((i) => [canon(i.sku_code), i.id]));
  const customerCodeToId = new Map(customers.map((c) => [canon(c.customer_code), c.id]));
  const customerNameToId = new Map(customers.map((c) => [canon(c.name), c.id]));

  // First pass — collect candidates + dedupe missing items/customers
  // for bulk-create. Doing per-row .upsert().select().single() on 21k
  // rows would take many minutes; bulk-create finishes in ~5s.
  type Candidate = {
    sku: string;
    skuSrc: Record<string, unknown>;
    customerName: string | null;
    customerKey: string | null;
    txnDate: string;
    qty: number;
    unitPrice: number | null;
    invoice: string | null;
    order: string | null;
    saleStore: string | null;
  };
  const candidates: Candidate[] = [];
  const missingSkus = new Map<string, Record<string, unknown>>();
  const missingCustomers = new Map<string, string>(); // canonName → name

  for (const r of rows) {
    const saleStore = String(pick(r, ["sale_store", "sale store", "store"]) ?? "").trim();
    // Skip pivot/summary rows (Xoro exports often append a "Grand Total" row).
    if (saleStore.toLowerCase() === "grand total") continue;

    const sku = extractSku(r);
    if (!sku) { result.skipped_no_sku++; continue; }

    const txnDate = toIsoDate(pick(r, ["date", "txn_date", "invoice_date", "ship_date", "order_date"]));
    if (!txnDate) { result.skipped_no_date++; continue; }

    const qty = toNum(pick(r, ["qty", "quantity", "total_sum_of_qty", "total sum of qty", "qty_shipped", "qty_invoiced"]));
    if (qty == null || qty <= 0) { result.skipped_zero_qty++; continue; }

    const customerKeyRaw = String(pick(r, ["customer_code", "customer", "customer_name", "account"]) ?? "").trim();
    const customerKey = customerKeyRaw || null;
    const unitPrice = toNum(pick(r, ["unit_price", "unit price - 2", "unit_price_-_2", "price", "unitprice"]));
    const invoice = String(pick(r, ["invoice_number", "invoice number", "invoice"]) ?? "").trim() || null;
    const order = String(pick(r, ["order_number", "order"]) ?? "").trim() || null;

    if (!skuToId.has(sku) && !missingSkus.has(sku)) missingSkus.set(sku, r);
    if (customerKey && !customerCodeToId.has(canon(customerKey)) && !customerNameToId.has(canon(customerKey)) && !missingCustomers.has(canon(customerKey))) {
      missingCustomers.set(canon(customerKey), customerKey);
    }

    candidates.push({ sku, skuSrc: r, customerName: customerKey, customerKey, txnDate, qty, unitPrice, invoice, order, saleStore: saleStore || null });
  }
  log(
    `First-pass: ${candidates.length.toLocaleString()} candidates · ${missingSkus.size} new SKUs · ${missingCustomers.size} new customers`,
    `Reviewed ${candidates.length.toLocaleString()} sales rows · ${missingSkus.size.toLocaleString()} new items · ${missingCustomers.size.toLocaleString()} new customers`,
  );

  // Bulk-upsert ALL items at style+color grain — not just missing ones,
  // so existing items get their style_code / color updated with the
  // original-spaced values from the Excel report. (Earlier SQL backfills
  // had set color from the no-space sku_code, losing the spaces.)
  // Dedupe by sku to avoid duplicate payload rows.
  const allSkuMap = new Map();
  for (const c of candidates) {
    if (!allSkuMap.has(c.sku)) allSkuMap.set(c.sku, c.skuSrc);
  }
  if (allSkuMap.size > 0) {
    log(
      `Bulk-upserting ${allSkuMap.size.toLocaleString()} items (refreshing color/style on existing too)…`,
      `Saving ${allSkuMap.size.toLocaleString()} items (updating colors and styles)…`,
    );
    const newItems = Array.from(allSkuMap.entries()).map(([sku, src]) => {
      const item = {
        sku_code: sku,
        style_code: String(pick(src, ["base_part_number", "base part number", "style_code", "style"]) ?? "").trim() || null,
        color: String(pick(src, ["option_1_value", "option 1 value", "color", "colour"]) ?? "").trim() || null,
        uom: "each",
        active: true,
      };
      // Only set description if Excel actually has one — don't clobber
      // descriptions that came from ATS sync with empty strings.
      const desc = String(pick(src, ["description", "title"]) ?? "").trim();
      if (desc) item.description = desc;
      return item;
    });
    // Bucket by key signature — see master-upload note. Sales-derived
    // items vary in whether `description` is set, which trips PGRST102
    // ("All object keys must match") on bulk upsert.
    const salesShapeBuckets = new Map<string, typeof newItems>();
    for (const it of newItems) {
      const sig = Object.keys(it).sort().join(",");
      let bucket = salesShapeBuckets.get(sig);
      if (!bucket) { bucket = []; salesShapeBuckets.set(sig, bucket); }
      bucket.push(it);
    }
    for (const [, bucket] of salesShapeBuckets) {
      for (let i = 0; i < bucket.length; i += 500) {
        const chunk = bucket.slice(i, i + 500);
        try {
          await sbPost(
            "ip_item_master?on_conflict=sku_code",
            chunk,
            "resolution=merge-duplicates,return=representation",
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`item bulk upsert chunk ${i}: ${msg}`);
          log(`✗ item chunk ${i} failed: ${msg}`, `Couldn't save some items: ${msg}`);
        }
      }
    }
    log(`Re-fetching items to refresh id map…`, `Refreshing item list…`);
    const refreshed = await wholesaleRepo.listItems();
    skuToId.clear();
    for (const i of refreshed) skuToId.set(canon(i.sku_code), i.id);
  }

  // Bulk-create missing customers (use name as customer_code so dedupe is stable)
  if (missingCustomers.size > 0) {
    log(
      `Bulk-creating ${missingCustomers.size.toLocaleString()} new customers…`,
      `Adding ${missingCustomers.size.toLocaleString()} new customers…`,
    );
    const newCusts = Array.from(missingCustomers.values()).map((name) => ({
      customer_code: `EXCEL:${canon(name)}`,
      name,
    }));
    for (let i = 0; i < newCusts.length; i += 500) {
      const chunk = newCusts.slice(i, i + 500);
      try {
        await sbPost(
          "ip_customer_master?on_conflict=customer_code",
          chunk,
          "resolution=merge-duplicates,return=representation",
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`customer bulk create chunk ${i}: ${msg}`);
        log(`✗ customer chunk ${i} failed: ${msg}`, `Couldn't save some customers: ${msg}`);
      }
    }
    const refreshedC = await wholesaleRepo.listCustomers();
    customerCodeToId.clear();
    customerNameToId.clear();
    for (const c of refreshedC) {
      customerCodeToId.set(canon(c.customer_code), c.id);
      customerNameToId.set(canon(c.name), c.id);
    }
  }

  // Second pass — build sales rows now that all ids exist
  log("Building final sales rows…", "Preparing sales records…");
  const out: Array<Record<string, unknown>> = [];
  for (const c of candidates) {
    const skuId = skuToId.get(c.sku);
    if (!skuId) { result.skipped_no_sku++; continue; }
    const customerId = c.customerKey
      ? (customerCodeToId.get(canon(c.customerKey)) ?? customerNameToId.get(canon(c.customerKey)) ?? null)
      : null;

    const lineKey = c.invoice ? `excel:inv:${c.invoice}:${c.sku}:${c.txnDate}`
                  : c.order   ? `excel:ord:${c.order}:${c.sku}:${c.txnDate}`
                              : `excel:${c.sku}:${c.txnDate}:${c.qty}`;
    out.push({
      sku_id: skuId,
      customer_id: customerId,
      category_id: null,
      channel_id: null,
      order_number: c.order,
      invoice_number: c.invoice,
      txn_type: c.invoice ? "invoice" : "ship",
      txn_date: c.txnDate,
      qty: c.qty,
      unit_price: c.unitPrice,
      gross_amount: c.unitPrice != null ? c.unitPrice * c.qty : null,
      discount_amount: null,
      net_amount: c.unitPrice != null ? c.unitPrice * c.qty : null,
      currency: "USD",
      source: "excel",
      raw_payload_id: null,
      source_line_key: lineKey,
    });
  }

  // Aggregate rows that share a source_line_key (same invoice +
  // style+color + date — produced when size is dropped from the SKU).
  // Sum qty, weight-average unit_price, recompute amounts.
  const merged = new Map<string, Record<string, unknown>>();
  for (const row of out) {
    const key = String(row.source_line_key);
    const existing = merged.get(key);
    if (!existing) { merged.set(key, row); continue; }
    // Counted as a duplicate so the upload-summary modal can show
    // every parsed row accounted for. The aggregate path above
    // weight-averages the prices and sums qty — no data is lost,
    // it just collapses N variant rows to 1 master row.
    result.skipped_duplicate++;
    const eQty = Number(existing.qty) || 0;
    const rQty = Number(row.qty) || 0;
    const totalQty = eQty + rQty;
    const eUp = existing.unit_price != null ? Number(existing.unit_price) : null;
    const rUp = row.unit_price != null ? Number(row.unit_price) : null;
    let mergedUp: number | null = null;
    if (eUp != null && rUp != null && totalQty > 0) {
      mergedUp = (eUp * eQty + rUp * rQty) / totalQty;
    } else if (eUp != null) mergedUp = eUp;
    else if (rUp != null) mergedUp = rUp;
    existing.qty = totalQty;
    existing.unit_price = mergedUp;
    existing.gross_amount = mergedUp != null ? mergedUp * totalQty : null;
    existing.net_amount = mergedUp != null ? mergedUp * totalQty : null;
  }
  const aggregated = Array.from(merged.values());
  if (aggregated.length < out.length) {
    log(
      `Aggregated ${out.length.toLocaleString()} → ${aggregated.length.toLocaleString()} rows (collapsed by style+color per invoice/date)`,
      `Combined ${out.length.toLocaleString()} rows into ${aggregated.length.toLocaleString()} (same style+color on the same invoice were merged)`,
    );
  }

  log(
    `Upserting ${aggregated.length.toLocaleString()} sales rows in 500-row chunks…`,
    `Saving ${aggregated.length.toLocaleString()} sales records…`,
  );
  for (let i = 0; i < aggregated.length; i += 500) {
    try {
      await sbPost(
        "ip_sales_history_wholesale?on_conflict=source,source_line_key",
        aggregated.slice(i, i + 500),
        "return=minimal,resolution=merge-duplicates",
      );
      result.inserted += Math.min(500, aggregated.length - i);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`sales chunk ${i}: ${msg}`);
      log(
        `✗ sales chunk ${i} (rows ${i}-${i + 500}) failed: ${msg}`,
        `Couldn't save sales records ${i.toLocaleString()}–${(i + 500).toLocaleString()}: ${msg}`,
      );
    }
    if ((i / 500) % 4 === 0) log(
      `  upsert progress ${i.toLocaleString()}/${aggregated.length.toLocaleString()}`,
      `Saved ${i.toLocaleString()} of ${aggregated.length.toLocaleString()}…`,
    );
  }
  log(
    `✓ DONE — parsed ${result.parsed.toLocaleString()}, upserted ${result.inserted.toLocaleString()}, errors ${result.errors.length}`,
    `Done — read ${result.parsed.toLocaleString()} rows, saved ${result.inserted.toLocaleString()} sales records, ${result.errors.length} error(s)`,
  );
  return result;
}

// ── Item master ────────────────────────────────────────────────────────────
//
// Authoritative source for style, color, description, and avg cost.
// Excel master row → ip_item_master AND ip_item_avg_cost. Sync handlers
// (Xoro sales, TandA POs, ATS supply) only auto-create stub items if
// missing — they no longer overwrite master fields.
//
// Expected columns (case-insensitive, multiple aliases):
//   SKU              ("sku", "sku_code", "item_number", "item")
//                    OR composite "Style" + "Color" (Style required)
//   Description      ("description", "title", "name")
//   Style            ("style", "style_code", "base_part_number")
//   Color            ("color", "colour", "option_1_value", "option 1 value")
//   AvgCost          ("avg_cost", "avg cost", "cost", "unit_cost", "unitcost")
//
// SKU resolution: explicit SKU column wins; otherwise compose from
// Style + Color and canonicalize.

export async function ingestItemMasterExcel(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<ExcelIngestResult> {
  // See ingestSalesExcel for the rationale: console gets the technical
  // line, the planner-facing status bar gets the friendly version.
  const log = (m: string, friendly?: string) => {
    console.log("[excel-master]", m);
    onProgress?.(friendly ?? m);
  };
  const result = empty();
  log(
    `Parsing ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`,
    `Reading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`,
  );
  const rows = await parseWorkbook(file, onProgress);
  result.parsed = rows.length;
  log(`Parsed ${rows.length.toLocaleString()} rows`, `Found ${rows.length.toLocaleString()} rows in the file`);
  if (rows.length === 0) return result;

  const itemPayload: Array<Record<string, unknown>> = [];
  // Variant-grain payload — one row per unique (style, color, size)
  // tuple from the Excel. Written to ip_item_master alongside the
  // rolled-up rows so the master holds size data for future PO
  // generation. Forecast/grid layers ignore these (size IS NOT NULL
  // filter) — they're consulted only when assembling Xoro POs.
  const variantPayload: Array<Record<string, unknown>> = [];
  // Variant-key dedup tracker. Stores the actual raw Excel rows that
  // mapped to each canonical (style, color, size) key so we can show
  // the planner what's colliding when they ask "Xoro wouldn't allow
  // duplicate item numbers — what are these?". After the loop, any
  // entry with rows.length > 1 becomes a duplicate group surfaced in
  // the upload modal.
  const variantRowsByKey = new Map<string, Array<Record<string, unknown>>>();
  const costPayload: Array<Record<string, unknown>> = [];
  const seenSkus = new Set<string>();
  // Quality counters — populated during the row loop, surfaced via
  // result.warnings/warning_counts at the end.
  const dq = {
    missing_color: 0,
    missing_size: 0,
    color_mismatches_skucode: 0,
    // Sample SKUs for each issue so the planner can spot-check which
    // master rows need fixing without scrolling through thousands.
    sample_missing_color: [] as string[],
    sample_color_mismatch: [] as string[],
  };
  const SAMPLE_LIMIT = 5;

  // Expanded aliases — common Excel column names from Xoro / TandA / ATS
  // exports plus typical planner spreadsheets. normHeader (in pick) strips
  // whitespace/punctuation so case + space variations all collapse.
  // NOTE: do NOT include "upc" / "barcode" — those are external identifiers,
  // not item codes, and treating them as SKUs corrupts the master.
  const SKU_ALIASES = [
    "sku", "sku code", "sku_code", "item number", "item_number", "itemnumber",
    "item", "item code", "item_code", "variant sku", "variant_sku",
    "product sku", "sku id", "style sku",
  ];
  const STYLE_ALIASES = [
    "style", "style code", "style_code", "style number", "style_number",
    "base part number", "base_part_number", "base part", "base_part",
    "parent sku", "parent_sku", "product code", "product_code",
  ];
  const COLOR_ALIASES = [
    "color", "colour", "color name", "colour name", "color_name", "colour_name",
    "option 1 value", "option_1_value", "option1value", "primary color",
    "main color", "shade", "wash",
  ];
  const SIZE_ALIASES = [
    "size", "size name", "size_name", "size code", "size_code",
    "option 2 value", "option_2_value", "option2value", "option2",
  ];
  const DESC_ALIASES = [
    "description", "desc", "item description", "product description",
    "long description", "short description", "title", "name",
    "item name", "product name", "style name",
    "body html", "bodyhtml", "body (html)",
  ];
  const COST_ALIASES = [
    "avg cost", "avg_cost", "avgcost", "average cost", "average_cost",
    "cost", "unit cost", "unit_cost", "unitcost", "std cost", "std_cost",
    "standard cost", "standard_cost", "standard unit cost",
    "moving avg cost", "moving average cost",
    "weighted cost", "wac", "fifo cost", "last cost",
  ];
  // Three-level category hierarchy stored in ip_item_master.attributes:
  //   ProductCategoryName  → product_category  (top level)
  //   ProductName / Group  → group_name        (mid — "Category" in UI)
  //   CategoryName         → category_name     (leaf — "Sub Cat" in UI)
  // Backward compat: GroupName / Department / Group still map to the mid
  // level; "category" without "name" still maps to sub cat. New uploads
  // can use the three-column pattern; old uploads keep working.
  const PRODUCT_CATEGORY_ALIASES = [
    "product category name", "productcategoryname", "product category",
    "productcategory",
  ];
  const GROUP_NAME_ALIASES = [
    "product name", "productname",
    "group name", "groupname", "group", "department", "dept",
  ];
  const CATEGORY_NAME_ALIASES = [
    "category name", "categoryname", "category", "sub category",
    "subcategory", "sub_category", "sub cat", "subcat",
  ];
  // Xoro export's `GenderCode` column. Stored in attributes for
  // filter-only use (no grid column rendered).
  const GENDER_ALIASES = [
    "gender code", "gendercode", "gender",
  ];

  for (const r of rows) {
    // SKU: direct column or compose from Style + Color.
    // SKU resolution:
    //   • Default: SKU = BasePartNumber (style-only). Color and size
    //     live on dedicated columns. Matches how supply sources
    //     (Xoro / ATS / TandA) report inventory at the base-style grain.
    //   • Pre-packs: when ANY of color / size / description / SKU
    //     contains "PPK", use the full ItemNumber as both sku_code AND
    //     style_code so the pre-pack stays SEPARATE from its base
    //     style. Without this, base RBB0185 ($4 unit) and pre-pack
    //     RBB0185-03SFPPK ($192 pack) collapse together when grouped
    //     by style and the cost surfaces as the pack cost.
    const explicitStyle = String(pick(r, STYLE_ALIASES) ?? "").trim();
    const explicitColor = String(pick(r, COLOR_ALIASES) ?? "").trim() || null;
    const rawSize = String(pick(r, SIZE_ALIASES) ?? "").trim() || null;
    const explicitSkuRaw = canon(pick(r, SKU_ALIASES) as string);
    const descRaw = String(pick(r, DESC_ALIASES) ?? "").trim();
    const isPrepack =
      /PPK/i.test(explicitColor ?? "") ||
      /PPK/i.test(rawSize ?? "") ||
      /PPK/i.test(descRaw) ||
      /PPK/i.test(explicitSkuRaw ?? "");
    // Pre-pack size fallback. When the Excel's Size column is blank
    // but the row is detected as a pre-pack (PPK token in any of the
    // other fields), derive the multiplier number from wherever it
    // appears and store it as "PPK{n}" so ATS / planning can compute
    // the pack→unit multiplier at lookup time. Without this, Excel
    // exports with sparse Size columns produce master rows whose
    // size is null, and the multiplier silently falls back to 1
    // (under-counting prepack inventory by the multiplier — the bug
    // we just spent the day cleaning up via SQL backfill).
    //
    // Order matches the planning grid's resolution chain so the same
    // number wins regardless of which field carries the token. Color
    // first because that's where the planning grid found it most
    // often historically; size last because if size already carried
    // a PPKn we wouldn't be in this branch.
    let explicitSize = rawSize;
    if (isPrepack && !explicitSize) {
      const detected =
        extractPpk(explicitColor) ??
        extractPpk(descRaw) ??
        extractPpk(explicitStyle) ??
        extractPpk(explicitSkuRaw);
      if (detected) explicitSize = `PPK${detected}`;
    }
    // Bare style code for prepacks. Computed once and reused for both
    // the rolled-up `sku` composition and the `style_code` field of
    // the rolled-up + variant rows below. Empty when not a prepack.
    const prepackStyle = isPrepack ? barePrepackStyle(explicitStyle, explicitSkuRaw) : "";
    let sku: string;
    if (isPrepack) {
      // Compose the rolled-up prepack sku from bare style + color.
      // The size lives in its own column ("PPKn" → size); baking it
      // into sku_code produces keys like "RYG1842PPK-BLACK-PPK60"
      // that Xoro never emits for the actual ATS row. Pre-packs with
      // the same bare style but different colors (e.g. RYO0822PPK in
      // Black/Salsa AND in Black/Egret) stay distinguished here by
      // appending the color to the dedup key.
      if (!prepackStyle) {
        result.skipped_no_sku++;
        continue;
      }
      sku = explicitColor ? canon(`${prepackStyle}-${explicitColor}`) : prepackStyle;
    } else if (explicitStyle) {
      // When the Excel has both Style and Color populated, dedup by
      // (style, color) so EACH variant becomes its own master row.
      // The earlier style-only dedup collapsed e.g. 31 RYB0412 color
      // variants into a single master row carrying just the first
      // row's color. Falls back to style-only when Color is blank
      // (style-level master upload — older Excel shape).
      sku = explicitColor
        ? canon(`${explicitStyle}-${explicitColor}`)
        : canon(explicitStyle);
    } else if (explicitSkuRaw) {
      sku = stripSizeSuffix(explicitSkuRaw);
    } else {
      result.skipped_no_sku++; continue;
    }
    // Accumulate the variant-grain row BEFORE the rolled-up dedup,
    // so a row that collapses at (style, color) — different size of
    // an already-seen variant — still contributes its full SKU to
    // ip_item_master. Variant key includes size; the rolled-up
    // dedup key (sku) does not.
    if (!sku) {
      result.skipped_no_sku++;
      continue;
    }
    // Set once the variant SKU is known: true when the rolled-up (style+color)
    // key differs from the physical variant SKU because a size axis was
    // stripped — i.e. this rolled-up row is a multi-size AGGREGATE and must NOT
    // carry any single size. Without this the rolled-up row inherits the FIRST
    // variant's size (e.g. RYB086930-BLACK gets size "28" from waist-28), and
    // every downstream consumer that reads the rolled-up sku_id — the AR mirror
    // especially — lumps ALL sizes' qty into that one stray size cell. Prepacks
    // are excluded: their rolled-up row legitimately stores "PPKn" as size.
    let rollupIsMultiSizeAggregate = false;
    {
      // Build the variant SKU.
      //
      // Priority: trust the explicit ItemNumber whenever it's set.
      // ItemNumber IS Xoro's unique physical-SKU identifier — Xoro
      // won't allow two distinct items to share one. Trusting it
      // avoids spurious collisions on rows where Style+Color+Size
      // is genuinely the same shape but the row represents a
      // different physical item (e.g. TRIM/label/accessory items
      // like FL00001-A, FL00001-B that share a BasePartNumber and
      // have blank Color/Size, but each is its own distinct SKU).
      //
      // Fallback (no explicit ItemNumber): synthesize from
      // Style+Color+Size as before. Pre-packs still composite with
      // color because the same pre-pack ItemNumber can appear
      // across multiple color combos.
      let variantSku: string;
      if (isPrepack) {
        // Pre-pack key: ItemNumber-Color (already encoded in `sku`
        // when explicitSkuRaw + explicitColor were set above).
        variantSku = sku;
      } else if (explicitSkuRaw) {
        variantSku = canon(explicitSkuRaw);
      } else {
        const sizePart = explicitSize ? `-${explicitSize}` : "";
        variantSku = sizePart ? canon(sku + sizePart) : sku;
      }
      rollupIsMultiSizeAggregate = !isPrepack && variantSku !== sku;
      // Surface non-prepack variant rows that have a Color set
      // but no Size — those are real apparel variants where size
      // is the missing axis. Skip rows without Color either, since
      // those are typically TRIM/accessory items where size is
      // genuinely not applicable (false positive otherwise).
      if (!isPrepack && !explicitSize && explicitColor) {
        result.no_size_skus.push(variantSku);
      }
      const existingRows = variantRowsByKey.get(variantSku);
      if (!existingRows) {
        variantRowsByKey.set(variantSku, [r]);
        const variantRow: Record<string, unknown> = {
          sku_code: variantSku,
          style_code: isPrepack ? prepackStyle : (explicitStyle ? canon(explicitStyle) : sku),
          color: explicitColor || null,
          size: explicitSize,
          uom: "each",
          active: true,
        };
        const desc = descRaw.includes("<")
          ? descRaw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
          : descRaw;
        if (desc) variantRow.description = desc;
        const variantCost = toNum(pick(r, COST_ALIASES));
        if (variantCost != null && variantCost >= 0) variantRow.unit_cost = variantCost;
        variantPayload.push(variantRow);
      } else {
        // Canonical (style, color, size) collision — same key as a
        // row already seen this upload. Count it AND retain the raw
        // row so the planner can inspect exactly what differs in
        // the modal (Xoro wouldn't allow a true duplicate item
        // number; usually the difference is in some column we're
        // not including in the dedup key, like warehouse / price
        // tier / category).
        existingRows.push(r);
        result.skipped_variant_duplicate++;
      }
    }

    if (seenSkus.has(sku)) {
      result.skipped_duplicate++;
      continue;
    }
    seenSkus.add(sku);

    // For pre-packs, style_code = the raw ItemNumber so masterByStyle
    // groups multiple color variants of the same pre-pack together
    // (e.g. RYO0822PPK in Black/Salsa AND in Black/Egret share style
    // RYO0822PPK). For everything else, style_code = BasePartNumber.
    // sku now carries the (style, color) pair when Color is set, so
    // we can't use sku directly here — would mis-stamp the style.
    const style = isPrepack
      ? prepackStyle
      : (explicitStyle ? canon(explicitStyle) : sku);
    const color = explicitColor;
    // Identifying-dimension validation. Skip pre-packs (sku == style by
    // design) and rows where sku == style_code (style-only master row,
    // not a variant — color genuinely doesn't apply).
    const isVariantRow = !isPrepack && sku !== style;
    if (isVariantRow) {
      if (!color) {
        dq.missing_color++;
        if (dq.sample_missing_color.length < SAMPLE_LIMIT) dq.sample_missing_color.push(sku);
      } else {
        // Sanity check: when both an explicit color and a sku_code
        // suffix exist, they should describe the same color (canonical
        // forms compared). Mismatches usually mean either the master
        // typed the wrong color or the SKU naming convention drifted —
        // either way the planner should know.
        const suffix = sku.startsWith(`${style}-`) ? sku.slice(style.length + 1).trim() : "";
        if (suffix) {
          const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (norm(suffix) !== norm(color)) {
            dq.color_mismatches_skucode++;
            if (dq.sample_color_mismatch.length < SAMPLE_LIMIT) {
              dq.sample_color_mismatch.push(`${sku} (color="${color}", sku suffix="${suffix}")`);
            }
          }
        }
      }
      if (!explicitSize) dq.missing_size++;
    }
    // Strip HTML when description came from a BodyHtml column.
    const description = descRaw.includes("<")
      ? descRaw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
      : descRaw;
    const cost = toNum(pick(r, COST_ALIASES));

    const productCategory = String(pick(r, PRODUCT_CATEGORY_ALIASES) ?? "").trim() || null;
    const groupName = String(pick(r, GROUP_NAME_ALIASES) ?? "").trim() || null;
    const subCategoryName = String(pick(r, CATEGORY_NAME_ALIASES) ?? "").trim() || null;
    const gender = String(pick(r, GENDER_ALIASES) ?? "").trim() || null;

    // PostgREST 12+ rejects bulk upserts where rows have different key sets
    // ("All object keys must match"). So every row carries the SAME shape;
    // null values mean "leave the existing value alone" only because we use
    // resolution=merge-duplicates with on_conflict — but be aware: with
    // merge-duplicates, sending {description: null} would actively set the
    // existing column to null. We don't want that for blanks. So instead of
    // omitting fields, we send them only when populated AND batch by shape:
    // build a stable shape per row, then group rows that have the same key
    // signature and upsert each group separately.
    const item: Record<string, unknown> = {
      sku_code: sku,
      style_code: style || null,
      color: color || null,
      // A multi-size rolled-up (style+color) aggregate carries NO size — the
      // per-size data lives on the variant rows above. Keep the explicit size
      // only for base/one-size SKUs (variantSku === sku) and prepacks (PPKn).
      size: rollupIsMultiSizeAggregate ? null : explicitSize,
      uom: "each",
      active: true,
    };
    if (description) item.description = description;
    if (productCategory || groupName || subCategoryName || gender) {
      item.attributes = {
        ...(productCategory ? { product_category: productCategory } : {}),
        ...(groupName ? { group_name: groupName } : {}),
        ...(subCategoryName ? { category_name: subCategoryName } : {}),
        ...(gender ? { gender } : {}),
      };
    }
    if (cost != null && cost >= 0) {
      item.unit_cost = cost;
      costPayload.push({
        sku_code: sku,
        avg_cost: cost,
        source: "excel",
        source_ref: file.name,
      });
    }
    itemPayload.push(item);
  }

  // Harvest variant-key collisions. Any key whose bucket has more
  // than one raw row is a (style, color, size) duplicate from the
  // planner's point of view. We keep the raw rows so the upload
  // modal can show the full source data and let the planner spot
  // which column actually differs (Xoro requires unique item
  // numbers, so a "true" duplicate is unexpected — usually it's a
  // multi-warehouse or multi-pricetier export collapsing).
  for (const [variant_key, groupRows] of variantRowsByKey) {
    if (groupRows.length > 1) {
      result.duplicate_variant_groups.push({ variant_key, rows: groupRows });
    }
  }

  // Merge new attributes with existing JSONB. PostgREST upsert REPLACES
  // the attributes column on conflict (it doesn't deep-merge JSONB), so
  // a partial upload that only carries GroupName would wipe an existing
  // category_name on the row. Read what's there, merge, send the union.
  const skusWithAttrs = itemPayload
    .filter((it) => it.attributes && typeof it.attributes === "object")
    .map((it) => String(it.sku_code));
  if (skusWithAttrs.length > 0) {
    log(
      `Pre-fetching attributes for ${skusWithAttrs.length.toLocaleString()} SKUs to preserve existing JSONB keys…`,
      `Checking existing details for ${skusWithAttrs.length.toLocaleString()} items so nothing is overwritten…`,
    );
    const existingAttrs = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < skusWithAttrs.length; i += 500) {
      const chunk = skusWithAttrs.slice(i, i + 500);
      const url = `${SB_URL}/rest/v1/ip_item_master?select=sku_code,attributes&sku_code=in.(${chunk.map(encodeURIComponent).join(",")})`;
      try {
        const r = await fetch(url, { headers: SB_HEADERS });
        if (r.ok) {
          const rows = (await r.json()) as Array<{ sku_code: string; attributes: Record<string, unknown> | null }>;
          for (const row of rows) {
            if (row.attributes && typeof row.attributes === "object") {
              existingAttrs.set(row.sku_code, row.attributes);
            }
          }
        }
      } catch {
        // If pre-fetch fails, fall through — the upsert will still run
        // (degraded: partial uploads may clobber the unset key).
      }
    }
    for (const it of itemPayload) {
      if (!it.attributes) continue;
      const existing = existingAttrs.get(String(it.sku_code));
      if (existing) {
        it.attributes = { ...existing, ...(it.attributes as Record<string, unknown>) };
      }
    }
  }

  // PostgREST 12+ rejects bulk upserts whose rows have different key
  // sets ("All object keys must match"). Rows here vary in shape because
  // description / unit_cost / attributes are only included when the Excel
  // cell is non-blank — sending them as null would clobber existing master
  // values with merge-duplicates. Group rows by their key signature so
  // each chunk is uniform.
  const shapeBuckets = new Map<string, Array<Record<string, unknown>>>();
  for (const item of itemPayload) {
    const sig = Object.keys(item).sort().join(",");
    let bucket = shapeBuckets.get(sig);
    if (!bucket) { bucket = []; shapeBuckets.set(sig, bucket); }
    bucket.push(item);
  }
  log(
    `Upserting ${itemPayload.length.toLocaleString()} item-master rows in ${shapeBuckets.size} shape bucket(s)…`,
    `Saving ${itemPayload.length.toLocaleString()} items…`,
  );
  let bucketIdx = 0;
  for (const [sig, bucket] of shapeBuckets) {
    bucketIdx++;
    log(
      `  bucket ${bucketIdx}/${shapeBuckets.size} (${bucket.length.toLocaleString()} rows · keys=${sig})`,
      `  group ${bucketIdx} of ${shapeBuckets.size} (${bucket.length.toLocaleString()} items)…`,
    );
    for (let i = 0; i < bucket.length; i += 500) {
      try {
        await sbPost(
          "ip_item_master?on_conflict=sku_code",
          bucket.slice(i, i + 500),
          "resolution=merge-duplicates,return=minimal",
        );
        result.inserted += Math.min(500, bucket.length - i);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`item bucket ${bucketIdx} chunk ${i}: ${msg}`);
        log(
          `✗ item bucket ${bucketIdx} chunk ${i} failed: ${msg}`,
          `Couldn't save some items in group ${bucketIdx}: ${msg}`,
        );
      }
    }
  }

  // ── Variant-grain upsert ──────────────────────────────────────────
  // Writes one row per unique (style, color, size) tuple from the
  // Excel. These rows live in ip_item_master alongside the rolled-up
  // rows; downstream queries distinguish them with `size IS NOT NULL`.
  // The grid never reads them (forecasts only point at rolled-up
  // sku_ids); the future PO builder reads them to assemble Xoro
  // line items at the full SKU grain.
  if (variantPayload.length > 0) {
    const variantBuckets = new Map<string, Array<Record<string, unknown>>>();
    for (const v of variantPayload) {
      const sig = Object.keys(v).sort().join(",");
      let bucket = variantBuckets.get(sig);
      if (!bucket) { bucket = []; variantBuckets.set(sig, bucket); }
      bucket.push(v);
    }
    log(
      `Upserting ${variantPayload.length.toLocaleString()} variant rows (size IS NOT NULL) in ${variantBuckets.size} shape bucket(s)…`,
      `Saving ${variantPayload.length.toLocaleString()} size-level records (full style + color + size detail)…`,
    );
    let vBucketIdx = 0;
    for (const [sig, bucket] of variantBuckets) {
      vBucketIdx++;
      log(
        `  variant bucket ${vBucketIdx}/${variantBuckets.size} (${bucket.length.toLocaleString()} rows · keys=${sig})`,
        `  size group ${vBucketIdx} of ${variantBuckets.size} (${bucket.length.toLocaleString()} items)…`,
      );
      for (let i = 0; i < bucket.length; i += 500) {
        try {
          await sbPost(
            "ip_item_master?on_conflict=sku_code",
            bucket.slice(i, i + 500),
            "resolution=merge-duplicates,return=minimal",
          );
          result.inserted_variants += Math.min(500, bucket.length - i);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`variant bucket ${vBucketIdx} chunk ${i}: ${msg}`);
          log(
            `✗ variant bucket ${vBucketIdx} chunk ${i} failed: ${msg}`,
            `Couldn't save some size-level records in group ${vBucketIdx}: ${msg}`,
          );
        }
      }
    }
  }

  if (costPayload.length > 0) {
    log(
      `Upserting ${costPayload.length.toLocaleString()} avg-cost rows…`,
      `Saving ${costPayload.length.toLocaleString()} cost records…`,
    );
    for (let i = 0; i < costPayload.length; i += 500) {
      try {
        await sbPost(
          "ip_item_avg_cost?on_conflict=sku_code",
          costPayload.slice(i, i + 500),
          "resolution=merge-duplicates,return=minimal",
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`cost chunk ${i}: ${msg}`);
      }
    }
  }

  // Surface data-quality findings. These are warnings, not errors —
  // ingest still succeeds — but they're loud enough that the planner
  // sees them in the upload status banner. The fix is upstream
  // (populate items.color/size in the master Excel before re-uploading).
  result.warning_counts = {
    missing_color: dq.missing_color,
    missing_size: dq.missing_size,
    color_mismatches_skucode: dq.color_mismatches_skucode,
  };
  if (dq.missing_color > 0) {
    let msg = `${dq.missing_color.toLocaleString()} variant row(s) had no Color set`;
    if (dq.sample_missing_color.length > 0) {
      msg += ` — e.g. ${dq.sample_missing_color.slice(0, 5).join(", ")}`;
      if (dq.missing_color > dq.sample_missing_color.length) msg += `, …`;
    }
    msg += `. Forecast will infer color from sku_code suffix; populate the master to silence this.`;
    result.warnings.push(msg);
  }
  if (dq.color_mismatches_skucode > 0) {
    let msg = `${dq.color_mismatches_skucode.toLocaleString()} variant(s) have a Color that disagrees with the sku_code suffix`;
    if (dq.sample_color_mismatch.length > 0) msg += ` — e.g. ${dq.sample_color_mismatch.slice(0, 3).join("; ")}`;
    msg += `. One side is wrong; reconcile in the master.`;
    result.warnings.push(msg);
  }
  if (dq.missing_size > 0) {
    result.warnings.push(`${dq.missing_size.toLocaleString()} variant row(s) had no Size set. Size-level grouping will be unreliable for those.`);
  }
  if (result.warnings.length > 0) {
    log(
      `⚠ ${result.warnings.length} data-quality warning(s):`,
      `${result.warnings.length} warning(s) about your file:`,
    );
    for (const w of result.warnings) log(`  - ${w}`, `  • ${w}`);
  }
  log(
    `✓ DONE — ${result.inserted.toLocaleString()} items, ${costPayload.length.toLocaleString()} avg costs, ${result.errors.length} errors`,
    `Done — saved ${result.inserted.toLocaleString()} items and ${costPayload.length.toLocaleString()} cost records, ${result.errors.length} error(s)`,
  );
  return result;
}
