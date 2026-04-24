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
import { fetchXoroAll } from "./_lib/xoro-client.js";

export const config = { maxDuration: 300 };

const SALES_PATH = "salesinvoice/getsalesinvoice";

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
  const defaultFrom = new Date(Date.now() - 395 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateFrom = url.searchParams.get("date_from") || defaultFrom;
  const dateTo = url.searchParams.get("date_to") || today;
  const path = url.searchParams.get("path") || SALES_PATH;
  const pageLimit = Math.min(parseInt(url.searchParams.get("page_limit") || "50", 10), 200);

  // ── Fetch from Xoro ────────────────────────────────────────────────────────
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

  // ── Normalize ──────────────────────────────────────────────────────────────
  const result = {
    xoro_lines_fetched: lines.length,
    inserted: 0,
    skipped_no_sku: 0,
    skipped_no_date: 0,
    skipped_zero_qty: 0,
    errors: [],
    path,
    date_from: dateFrom,
    date_to: dateTo,
  };

  const rows = [];
  for (const ln of lines) {
    const sku = canonSku(ln.Sku ?? ln.ItemNumber);
    if (!sku) { result.skipped_no_sku++; continue; }

    const skuId = skuToId.get(sku);
    if (!skuId) { result.skipped_no_sku++; continue; }

    const txnDate = toIsoDate(ln.InvoiceDate ?? ln.ShipDate ?? ln.TxnDate ?? ln.OrderDate);
    if (!txnDate) { result.skipped_no_date++; continue; }

    const qty = toNum(ln.QtyInvoiced ?? ln.QtyShipped ?? ln.Qty) ?? 0;
    if (qty <= 0) { result.skipped_zero_qty++; continue; }

    const customerId =
      customerCodeToId.get(canonSku(ln.CustomerNumber ?? ln.CustomerCode)) ??
      customerNameToId.get(canonName(ln.CustomerName)) ??
      null;

    const catRaw = ln.CategoryName ?? null;
    const categoryId =
      catCodeToId.get(canonSku(catRaw)) ??
      catNameToId.get(canonName(catRaw)) ??
      null;

    const invoice = String(ln.InvoiceNumber ?? "").trim() || null;
    const order = String(ln.OrderNumber ?? "").trim() || null;
    const id = String(ln.Id ?? "").trim();
    const source_line_key =
      invoice && id ? `xoro:inv:${invoice}:${id}` :
      order && id   ? `xoro:ord:${order}:${id}` :
                      `xoro:${sku}:${txnDate}:${id || "nil"}`;

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
      unit_price: toNum(ln.UnitPrice),
      gross_amount: toNum(ln.LineAmount),
      discount_amount: toNum(ln.DiscountAmount),
      net_amount: toNum(ln.NetAmount),
      currency: ln.Currency ?? null,
      source: "xoro",
      raw_payload_id: null,
      source_line_key,
    });
  }

  // ── Upsert in 500-row chunks ───────────────────────────────────────────────
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_sales_history_wholesale")
      .upsert(chunk, { onConflict: "source_line_key", ignoreDuplicates: false });
    if (error) result.errors.push(error.message);
    else result.inserted += chunk.length;
  }

  return res.status(200).json(result);
}
