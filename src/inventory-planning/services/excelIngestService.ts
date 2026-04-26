// Client-side Excel ingest for planning data. Used as the manual fallback
// when the Xoro API isn't wired up (e.g. invoices/sales-history endpoint
// not provisioned on the customer's Xoro account).
//
// Two flows:
//   ingestSalesExcel(file)   — sales history → ip_sales_history_wholesale
//   ingestAvgCostExcel(file) — per-SKU avg cost → ip_item_avg_cost
//
// Parsing happens in the browser via xlsx; persistence is direct Supabase
// REST upsert so we don't pay another serverless cold start.

import * as XLSX from "xlsx";
import { SB_HEADERS, SB_URL } from "../../utils/supabase";
import { wholesaleRepo } from "./wholesalePlanningRepository";

export interface ExcelIngestResult {
  parsed: number;
  inserted: number;
  skipped_no_sku: number;
  skipped_no_date: number;
  skipped_zero_qty: number;
  skipped_bad_cost: number;
  errors: string[];
}

const empty = (): ExcelIngestResult => ({
  parsed: 0, inserted: 0, skipped_no_sku: 0,
  skipped_no_date: 0, skipped_zero_qty: 0, skipped_bad_cost: 0, errors: [],
});

function canon(s: string | null | undefined): string {
  return (s ?? "").toString().trim().toUpperCase();
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
// insensitive. Excel templates vary — let users name columns naturally.
function pick(row: Record<string, unknown>, names: string[]): unknown {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v != null && v !== "") return v;
  }
  return null;
}

async function parseWorkbook(file: File): Promise<Record<string, unknown>[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
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

// Pulls out a SKU from a row. Tries direct columns first, then composes
// from "Base Part Number" + "Option 1 Value" (+ optional "Option 2 Value")
// the way Xoro report exports lay it out.
function extractSku(r: Record<string, unknown>): string {
  const direct = canon(pick(r, ["sku", "sku_code", "item_number", "itemnumber", "item"]) as string);
  if (direct) return direct;
  const base = String(pick(r, ["base_part_number", "base part number", "base_part", "style_code", "style"]) ?? "").trim();
  if (!base) return "";
  const opt1 = String(pick(r, ["option_1_value", "option 1 value", "color", "colour"]) ?? "").trim();
  const opt2 = String(pick(r, ["option_2_value", "option 2 value", "size"]) ?? "").trim();
  const parts = [base, opt1, opt2].filter(Boolean);
  return canon(parts.join("-"));
}

export async function ingestSalesExcel(file: File): Promise<ExcelIngestResult> {
  const result = empty();
  const rows = await parseWorkbook(file);
  result.parsed = rows.length;
  if (rows.length === 0) return result;

  const [items, customers] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listCustomers(),
  ]);
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

  // Bulk-create missing items
  if (missingSkus.size > 0) {
    const newItems = Array.from(missingSkus.entries()).map(([sku, src]) => ({
      sku_code: sku,
      style_code: String(pick(src, ["base_part_number", "base part number", "style_code", "style"]) ?? "").trim() || null,
      description: String(pick(src, ["description", "title"]) ?? "").trim() || null,
      color: String(pick(src, ["option_1_value", "option 1 value", "color", "colour"]) ?? "").trim() || null,
      size: String(pick(src, ["option_2_value", "option 2 value", "size"]) ?? "").trim() || null,
      uom: "each",
      active: true,
    }));
    for (let i = 0; i < newItems.length; i += 500) {
      const chunk = newItems.slice(i, i + 500);
      await sbPost(
        "ip_item_master?on_conflict=sku_code",
        chunk,
        "resolution=merge-duplicates,return=representation",
      );
    }
    // Re-fetch items to get fresh ids.
    const refreshed = await wholesaleRepo.listItems();
    skuToId.clear();
    for (const i of refreshed) skuToId.set(canon(i.sku_code), i.id);
    result.errors = result.errors;
  }

  // Bulk-create missing customers (use name as customer_code so dedupe is stable)
  if (missingCustomers.size > 0) {
    const newCusts = Array.from(missingCustomers.values()).map((name) => ({
      customer_code: `EXCEL:${canon(name)}`,
      name,
    }));
    for (let i = 0; i < newCusts.length; i += 500) {
      const chunk = newCusts.slice(i, i + 500);
      await sbPost(
        "ip_customer_master?on_conflict=customer_code",
        chunk,
        "resolution=merge-duplicates,return=representation",
      );
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

  for (let i = 0; i < out.length; i += 500) {
    await sbPost(
      "ip_sales_history_wholesale?on_conflict=source,source_line_key",
      out.slice(i, i + 500),
      "return=minimal,resolution=merge-duplicates",
    );
    result.inserted += Math.min(500, out.length - i);
  }
  return result;
}

// ── Avg costs ──────────────────────────────────────────────────────────────
//
// Expected columns:
//   SKU       (or sku_code, item_number)
//   AvgCost   (or avg_cost, cost, unit_cost)
//   [Source]  (optional — defaults to "excel")

export async function ingestAvgCostExcel(file: File): Promise<ExcelIngestResult> {
  const result = empty();
  const rows = await parseWorkbook(file);
  result.parsed = rows.length;
  if (rows.length === 0) return result;

  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const sku = canon(pick(r, ["sku", "sku_code", "item_number", "itemnumber", "item"]) as string);
    if (!sku) { result.skipped_no_sku++; continue; }

    const cost = toNum(pick(r, ["avg_cost", "avgcost", "cost", "unit_cost", "unitcost"]));
    if (cost == null || cost < 0) { result.skipped_bad_cost++; continue; }

    out.push({
      sku_code: sku,
      avg_cost: cost,
      source: "excel",
      source_ref: file.name,
    });
  }

  if (out.length === 0) return result;
  await wholesaleRepo.upsertItemAvgCost(out as never);
  result.inserted = out.length;
  return result;
}
