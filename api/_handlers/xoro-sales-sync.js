// api/xoro-sales-sync.js — Vercel Node.js Serverless Function
//
// Pulls wholesale sales invoices from Xoro and upserts into
// ip_sales_history_wholesale. Called on-demand from the wholesale workbench.
//
// Query params:
//   date_from   ISO date (default: 13 months ago)
//   date_to     ISO date (default: today)
//   path        Xoro endpoint override (default: salesinvoice/getsalesinvoice)
//   page_limit  max pages to fetch (default: 50)

import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll } from "../_lib/xoro-client.js";

export const config = { maxDuration: 300 };

// Xoro sales-history endpoint. Singular pattern matches TandA's working
// `purchaseorder/getpurchaseorder`. Override via ?path=<module>/<action>
// (try `invoices/getinvoices` plural variant if singular returns empty).
const SALES_PATH = "invoice/getinvoice";

function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toNum(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

function canonSku(raw) {
  if (!raw) return null;
  return String(raw).trim().toUpperCase().replace(/\s+/g, "");
}

function canonName(raw) {
  if (!raw) return null;
  return String(raw).trim().toUpperCase().replace(/\s+/g, " ");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured", supabase: !!SB_URL, serviceKey: !!SERVICE_KEY });
  }

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const url = new URL(req.url, `https://${req.headers.host}`);

  const today = new Date().toISOString().slice(0, 10);
  // Default to 30 days to keep a single invocation under the function
  // duration cap. Use the date pickers in the UI to widen, or call this
  // route in chunks (e.g. month at a time).
  const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateFrom = url.searchParams.get("date_from") || defaultFrom;
  const dateTo = url.searchParams.get("date_to") || today;
  const path = url.searchParams.get("path") || SALES_PATH;
  // Each page = 100 invoices, each fanning out to ~10 line items each
  // (~1k row upserts). Default to 1 page so the function finishes in
  // ~10-20s even when Xoro is slow; use ?page_limit= to backfill more.
  const pageLimit = Math.min(parseInt(url.searchParams.get("page_limit") || "1", 10), 50);
  // Page tracker so successive UI clicks step through pages 1, 2, 3 …
  // within the same date window without reprocessing the same invoices.
  const pageStart = Math.max(parseInt(url.searchParams.get("page_start") || "1", 10), 1);

  // ── Fetch from Xoro ────────────────────────────────────────────────────────
  // module: "sales" → uses VITE_XORO_SALES_API_KEY/SECRET (separate creds
  // Xoro provisions for the sales-history endpoint).
  const xoroResult = await fetchXoroAll({
    path,
    params: {
      per_page: "200",
      // Send both common date param names — Xoro endpoint varies.
      from_date: dateFrom,
      to_date: dateTo,
      InvoiceDateFrom: dateFrom,
      InvoiceDateTo: dateTo,
    },
    maxPages: pageLimit,
    module: "sales",
    pageStart,
  });

  if (!xoroResult.ok) {
    return res.status(200).json({
      error: "Xoro fetch failed — check path and credentials",
      path,
      date_from: dateFrom,
      date_to: dateTo,
      xoro_lines_fetched: 0,
      inserted: 0,
      debug: xoroResult.body,
    });
  }

  const lines = Array.isArray(xoroResult.body?.Data) ? xoroResult.body.Data : [];

  // ── Load masters for reconciliation ────────────────────────────────────────
  const [{ data: items }, { data: customers }, { data: categories }] = await Promise.all([
    admin.from("ip_item_master").select("id, sku_code"),
    admin.from("ip_customer_master").select("id, customer_code, name"),
    admin.from("ip_category_master").select("id, category_code, name"),
  ]);

  const skuToId = new Map((items ?? []).map((i) => [canonSku(i.sku_code), i.id]));
  const customerCodeToId = new Map((customers ?? []).map((c) => [canonSku(c.customer_code), c.id]));
  const customerNameToId = new Map((customers ?? []).map((c) => [canonName(c.name), c.id]));
  const catCodeToId = new Map((categories ?? []).map((c) => [canonSku(c.category_code), c.id]));
  const catNameToId = new Map((categories ?? []).map((c) => [canonName(c.name), c.id]));

  // ── Wholesale-only filter ──────────────────────────────────────────────────
  // Xoro's invoice list spans every channel (wholesale + DTC + Shopify etc.).
  // For the wholesale planning grid we only want wholesale invoices.
  //
  // Two filter dimensions, configurable via query (overrides env):
  //   Store codes:
  //     ?include_stores=PT,WH         — allowlist
  //     ?exclude_stores=SHOPIFY,AMZ   — denylist
  //   Customer name substring (case-insensitive, comma-separated):
  //     ?exclude_customer_contains=shopify,amazon
  //
  // Env defaults: XORO_WHOLESALE_INCLUDE_STORES / EXCLUDE_STORES /
  // EXCLUDE_CUSTOMER_CONTAINS. Customer-name denylist defaults to
  // "shopify" since that's the ecom-channel indicator on this account.
  const parseList = (s) => (s ? s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : []);
  const includeStores = new Set(parseList(url.searchParams.get("include_stores") || process.env.XORO_WHOLESALE_INCLUDE_STORES || ""));
  const excludeStores = new Set(parseList(url.searchParams.get("exclude_stores") || process.env.XORO_WHOLESALE_EXCLUDE_STORES || ""));
  const excludeCustomerContains = parseList(url.searchParams.get("exclude_customer_contains") || process.env.XORO_WHOLESALE_EXCLUDE_CUSTOMER_CONTAINS || "shopify");
  const seenStoreCodes = new Map();

  // ── Normalize ──────────────────────────────────────────────────────────────
  const result = {
    xoro_lines_fetched: lines.length,
    inserted: 0,
    skipped_no_sku: 0,
    skipped_no_date: 0,
    skipped_zero_qty: 0,
    skipped_ecom_store: 0,
    skipped_outside_window: 0,
    errors: [],
    path,
    date_from: dateFrom,
    date_to: dateTo,
    page_start: pageStart,
    page_limit: pageLimit,
  };

  const rows = [];
  // Track skip reasons so the response can show what's blocking ingest.
  const unmatchedSkuSamples = [];
  // Each Xoro "line" is actually an invoice envelope with invoiceHeader +
  // invoiceItemLineArr. Flatten: one sales-history row per item line.
  for (const inv of lines) {
    const header = inv.invoiceHeader ?? inv;
    const itemLines = Array.isArray(inv.invoiceItemLineArr) ? inv.invoiceItemLineArr : [];

    // Client-side date filter — Xoro's invoice/getinvoice endpoint does
    // not honor date_from/date_to params (TandA's PO sync hit the same
    // wall and filters client-side too). So we always paginate from
    // newest, then drop invoices outside the requested window.
    const headerDate = toIsoDate(header.ShipDate ?? header.TxnDate ?? header.DateOrder ?? header.InvoiceDate);
    if (headerDate && (headerDate < dateFrom || headerDate > dateTo)) {
      result.skipped_outside_window++;
      continue;
    }

    // Track store codes seen so the response can help the planner
    // configure include/exclude lists without guessing.
    const storeCode = String(header.StoreCode ?? header.SaleStoreCode ?? "").trim().toUpperCase();
    const storeName = String(header.StoreName ?? header.SaleStoreName ?? "").trim();
    if (storeCode) {
      const cur = seenStoreCodes.get(storeCode);
      seenStoreCodes.set(storeCode, { name: cur?.name ?? storeName, count: (cur?.count ?? 0) + 1 });
    }

    // Apply store filter — allowlist wins if set, otherwise denylist.
    if (includeStores.size > 0) {
      if (!storeCode || !includeStores.has(storeCode)) { result.skipped_ecom_store++; continue; }
    } else if (excludeStores.size > 0 && storeCode && excludeStores.has(storeCode)) {
      result.skipped_ecom_store++; continue;
    }

    // Apply customer-name substring denylist (defaults to "shopify").
    if (excludeCustomerContains.length > 0) {
      const customerHaystack = `${header.CustomerName ?? ""} ${header.CustomerFullName ?? ""} ${header.BillToCompanyName ?? ""}`.toUpperCase();
      if (excludeCustomerContains.some((needle) => customerHaystack.includes(needle))) {
        result.skipped_ecom_store++; continue;
      }
    }

    const txnDate = toIsoDate(header.ShipDate ?? header.TxnDate ?? header.DateOrder ?? header.InvoiceDate);
    const invoice = String(header.InvoiceNumber ?? "").trim() || null;
    const order = String(header.SoNumber ?? header.RefNo ?? header.OrderNumber ?? "").trim() || null;
    let customerId =
      customerCodeToId.get(canonSku(header.CustomerAccountNumber ?? header.CustomerNumber)) ??
      customerNameToId.get(canonName(header.CustomerName ?? header.CustomerFullName ?? header.BillToCompanyName)) ??
      null;
    // Auto-create missing customers — runForecastPass filters out sales
    // rows with customer_id=null, so invoices without a master row would
    // never count toward history. ip_customer_master keys on customer_code
    // (we use the Xoro CustomerId as the stable code).
    if (!customerId) {
      const xCustomerId = header.CustomerId ?? header.CustomerNumber ?? null;
      const customerCode = xCustomerId != null ? `XORO:${xCustomerId}` : null;
      const customerName = header.CustomerName ?? header.CustomerFullName ?? header.BillToCompanyName ?? null;
      if (customerCode && customerName) {
        const { data: createdCust, error: custErr } = await admin
          .from("ip_customer_master")
          .upsert({ customer_code: customerCode, name: customerName }, { onConflict: "customer_code", ignoreDuplicates: false })
          .select("id, customer_code, name")
          .single();
        if (!custErr && createdCust) {
          customerId = createdCust.id;
          customerCodeToId.set(canonSku(customerCode), customerId);
          customerNameToId.set(canonName(customerName), customerId);
          result.auto_created_customers = (result.auto_created_customers ?? 0) + 1;
        }
      }
    }
    const currency = header.CurrencyCode ?? null;

    if (itemLines.length === 0) {
      if (unmatchedSkuSamples.length < 3) unmatchedSkuSamples.push({ reason: "invoiceItemLineArr empty", invoice });
      result.skipped_no_sku++; continue;
    }

    for (const il of itemLines) {
      const skuRaw = il.ItemNumber ?? il.Sku ?? il.ItemCode ?? il.Item ?? il.Product ?? il.ProductCode;
      const sku = canonSku(skuRaw);
      if (!sku) {
        if (unmatchedSkuSamples.length < 3) unmatchedSkuSamples.push({ reason: "no SKU on item line", invoice, line_keys: Object.keys(il).slice(0, 30) });
        result.skipped_no_sku++; continue;
      }

      // Auto-create missing items from invoice line metadata so the
      // forecast grid resolves real SKUs without a separate items sync.
      // Cheaper than the full Xoro item endpoint and means new SKUs land
      // in the master the moment they show up on a real invoice.
      let skuId = skuToId.get(sku);
      if (!skuId) {
        const desc = il.Description ?? il.Title ?? null;
        const sellPrice = toNum(il.UnitPrice ?? il.EffectiveUnitPrice);
        const newRow = {
          sku_code: sku,
          description: desc,
          unit_price: sellPrice,
          uom: (il.SellUomCode ?? "each").toLowerCase(),
          external_refs: { xoro_item_id: il.ItemId ?? null, xoro_upc: il.ItemUpc ?? null },
          active: true,
        };
        const { data: created, error: itemErr } = await admin
          .from("ip_item_master")
          .upsert(newRow, { onConflict: "sku_code", ignoreDuplicates: false })
          .select("id, sku_code")
          .single();
        if (itemErr || !created) {
          if (unmatchedSkuSamples.length < 3) unmatchedSkuSamples.push({ reason: "auto-create failed", sku, error: itemErr?.message });
          result.skipped_no_sku++; continue;
        }
        skuId = created.id;
        skuToId.set(sku, skuId);
        result.auto_created_skus = (result.auto_created_skus ?? 0) + 1;
      }

      if (!txnDate) { result.skipped_no_date++; continue; }

      const qty = toNum(il.Qty ?? il.QtyInvoiced ?? il.QtyShipped) ?? 0;
      if (qty <= 0) { result.skipped_zero_qty++; continue; }

      const catRaw = il.ItemCategoryName ?? null;
      const categoryId =
        catCodeToId.get(canonSku(catRaw)) ??
        catNameToId.get(canonName(catRaw)) ??
        null;

      const lineId = String(il.Id ?? il.SoLineId ?? "").trim();
      const source_line_key =
        invoice && lineId ? `xoro:inv:${invoice}:${lineId}` :
        order && lineId   ? `xoro:ord:${order}:${lineId}` :
                            `xoro:${sku}:${txnDate}:${lineId || "nil"}`;

      // gross = pre-discount line total; net = post-discount. Falls back to
      // gross − discount when Xoro doesn't return an explicit NetAmount.
      // Matches ip-normalize-pipeline.js so ip-ai-demand reads net_amount
      // as actual revenue rather than gross overstated by the discount.
      const grossAmount = toNum(il.LineAmount ?? il.TotalAmount);
      const discountAmount = toNum(il.DiscountAmount ?? il.Discount);
      const netAmount = toNum(il.NetAmount)
        ?? (grossAmount != null ? grossAmount - (discountAmount ?? 0) : null);

      rows.push({
        sku_id: skuId,
        customer_id: customerId,
        category_id: categoryId,
        channel_id: null,
        order_number: order,
        invoice_number: invoice,
        txn_type: "invoice",
        txn_date: txnDate,
        qty,
        unit_price: toNum(il.UnitPrice ?? il.EffectiveUnitPrice),
        gross_amount: grossAmount,
        discount_amount: discountAmount,
        net_amount: netAmount,
        currency,
        source: "xoro",
        raw_payload_id: null,
        source_line_key,
      });
    }
  }

  // ── Upsert in 500-row chunks ───────────────────────────────────────────────
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_sales_history_wholesale")
      .upsert(chunk, { onConflict: "source,source_line_key", ignoreDuplicates: false });
    if (error) result.errors.push(error.message);
    else result.inserted += chunk.length;
  }

  // Detect when we've paginated past the requested window so the UI can
  // tell the user to stop clicking. True when every invoice in this batch
  // was older than date_from.
  const oldestInBatch = lines.reduce((oldest, inv) => {
    const h = inv.invoiceHeader ?? inv;
    const d = toIsoDate(h.ShipDate ?? h.TxnDate ?? h.DateOrder ?? h.InvoiceDate);
    return d && (oldest == null || d < oldest) ? d : oldest;
  }, null);
  result.oldest_invoice_in_batch = oldestInBatch;
  result.past_window = oldestInBatch != null && oldestInBatch < dateFrom;

  // Always surface the store-code breakdown so the planner can tune the
  // wholesale include/exclude lists without guessing.
  result.seen_stores = Object.fromEntries(
    Array.from(seenStoreCodes.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([code, info]) => [code, { name: info.name, invoices: info.count }])
  );
  result.store_filter = {
    include: Array.from(includeStores),
    exclude: Array.from(excludeStores),
    exclude_customer_contains: excludeCustomerContains,
  };

  // When nothing matched, surface the diagnostic so the planner can see
  // what Xoro actually returned (field names + sample SKU values) and
  // either add the missing items to ip_item_master or rename SKUs.
  if (rows.length === 0 && lines.length > 0) {
    result.diagnostic = {
      hint: "All Xoro lines skipped — check store filter, SKU mapping, and ip_item_master.",
      sample_unmatched: unmatchedSkuSamples,
      first_line_field_names: Object.keys(lines[0]).slice(0, 40),
      first_line_preview: lines[0],
    };
  }

  return res.status(200).json(result);
}
