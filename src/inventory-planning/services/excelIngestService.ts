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
// Expected columns (any of these names — case insensitive):
//   SKU         (or sku_code, item_number, item)
//   Customer    (or customer_name, customer_code, account)
//   Date        (or txn_date, ship_date, invoice_date, order_date)
//   Qty         (or quantity, qty_shipped, qty_invoiced)
//   UnitPrice   (optional)
//   InvoiceNumber / OrderNumber (optional, for source_line_key)

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

  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const sku = canon(pick(r, ["sku", "sku_code", "item_number", "itemnumber", "item"]) as string);
    if (!sku) { result.skipped_no_sku++; continue; }
    const skuId = skuToId.get(sku);
    if (!skuId) { result.skipped_no_sku++; continue; }

    const txnDate = toIsoDate(pick(r, ["date", "txn_date", "invoice_date", "ship_date", "order_date"]));
    if (!txnDate) { result.skipped_no_date++; continue; }

    const qty = toNum(pick(r, ["qty", "quantity", "qty_shipped", "qty_invoiced"]));
    if (qty == null || qty <= 0) { result.skipped_zero_qty++; continue; }

    const customerKey = pick(r, ["customer_code", "customer", "customer_name", "account"]);
    const customerId =
      customerCodeToId.get(canon(customerKey as string)) ??
      customerNameToId.get(canon(customerKey as string)) ??
      null;

    const invoice = String(pick(r, ["invoice_number", "invoice"]) ?? "").trim() || null;
    const order = String(pick(r, ["order_number", "order"]) ?? "").trim() || null;
    const lineKey = invoice ? `excel:inv:${invoice}:${sku}:${txnDate}`
                  : order   ? `excel:ord:${order}:${sku}:${txnDate}`
                            : `excel:${sku}:${txnDate}:${qty}`;

    out.push({
      sku_id: skuId,
      customer_id: customerId,
      category_id: null,
      channel_id: null,
      order_number: order,
      invoice_number: invoice,
      txn_type: invoice ? "invoice" : "ship",
      txn_date: txnDate,
      qty,
      unit_price: toNum(pick(r, ["unit_price", "price", "unitprice"])),
      gross_amount: null,
      discount_amount: null,
      net_amount: null,
      currency: null,
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
