// api/internal/inventory-sold-detail
//
// Drill-down for the Inventory Snapshot "Sold" cell. For one style (+ optional
// date range) returns per-colour totals + a grand total + the invoice list
// (one row per invoice × colour) the popup shows, with each invoice resolved to
// its AR invoice id so the number is clickable. Sourced from the Xoro-mirrored
// sales history (ip_sales_history_wholesale = invoiced wholesale lines; ecom
// orders are included with their order number, no invoice).
//
// GET ?style_id=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
//   → { color_totals:[{ color, qty, avg_unit_price }], grand_total,
//       rows:[{ color, store, qty, invoice_number, ar_invoice_id, customer,
//               unit_price, date, kind }] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK = 100;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function chunks(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
async function entityId(admin) { const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle(); return data?.id || null; }
async function fetchChunked(ids, fn) { const rows = []; for (const s of chunks(ids, CHUNK)) { const { data, error } = await fn(s); if (error) throw new Error(error.message); if (data) rows.push(...data); } return rows; }

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, "http://x");
  const styleId = String(url.searchParams.get("style_id") || "");
  if (!UUID_RE.test(styleId)) return res.status(400).json({ error: "style_id (uuid) required" });
  const from = DATE_RE.test(String(url.searchParams.get("from") || "")) ? String(url.searchParams.get("from")) : null;
  const to = DATE_RE.test(String(url.searchParams.get("to") || "")) ? String(url.searchParams.get("to")) : null;

  try {
    const eid = await entityId(admin);
    // SKUs of this style → item_id → color.
    const items = await fetchChunked([styleId], (ids) =>
      admin.from("ip_item_master").select("id, color").in("style_id", ids));
    const colorByItem = new Map(items.map((i) => [i.id, i.color ?? null]));
    const itemIds = items.map((i) => i.id);
    if (itemIds.length === 0) return res.status(200).json({ color_totals: [], grand_total: 0, rows: [] });

    // Wholesale invoiced lines (the rows the popup lists).
    // NB: ip_sales_history_wholesale has NO `store` column — selecting it 400s
    // (PostgREST) and the drill returns 500. Wholesale rows show store = null.
    const whRows = await fetchChunked(itemIds, (ids) => {
      let q = admin.from("ip_sales_history_wholesale")
        .select("sku_id, qty, unit_price, txn_date, invoice_number, customer_id")
        .in("sku_id", ids);
      if (from) q = q.gte("txn_date", from);
      if (to) q = q.lte("txn_date", to);
      return q;
    });
    // Ecom orders (no invoice number — keyed by order number).
    const ecRows = await fetchChunked(itemIds, (ids) => {
      let q = admin.from("ip_sales_history_ecom")
        .select("sku_id, net_qty, order_number, order_date")
        .in("sku_id", ids);
      if (from) q = q.gte("order_date", from);
      if (to) q = q.lte("order_date", to);
      return q;
    });

    // Customer names + AR invoice ids (so the number is clickable).
    const custIds = [...new Set(whRows.map((r) => r.customer_id).filter(Boolean))];
    const custName = new Map();
    if (custIds.length) {
      const crows = await fetchChunked(custIds, (ids) => admin.from("customers").select("id, name").in("id", ids));
      for (const c of crows) custName.set(c.id, c.name);
    }
    const invNums = [...new Set(whRows.map((r) => r.invoice_number).filter(Boolean))];
    const arIdByNum = new Map();
    if (invNums.length && eid) {
      const arrows = await fetchChunked(invNums, (nums) =>
        admin.from("ar_invoices").select("id, invoice_number").eq("entity_id", eid).in("invoice_number", nums));
      for (const a of arrows) arIdByNum.set(a.invoice_number, a.id);
    }

    // Group wholesale into one row per (invoice_number, color); ecom per (order, color).
    const rowMap = new Map();
    const addRow = (key, base, qty, price) => {
      let r = rowMap.get(key);
      if (!r) { r = { ...base, qty: 0, _amt: 0, _pq: 0 }; rowMap.set(key, r); }
      r.qty += qty;
      if (price != null) { r._amt += price * qty; r._pq += qty; }
    };
    for (const r of whRows) {
      const color = colorByItem.get(r.sku_id) ?? null;
      const qty = Number(r.qty) || 0;
      const price = r.unit_price != null ? Number(r.unit_price) : null;
      addRow(`w|${r.invoice_number ?? ""}|${color ?? ""}`, {
        color, store: r.store ?? null, invoice_number: r.invoice_number ?? null,
        ar_invoice_id: arIdByNum.get(r.invoice_number) || null,
        customer: custName.get(r.customer_id) || null, date: r.txn_date ?? null, kind: "wholesale",
      }, qty, price);
    }
    for (const r of ecRows) {
      const color = colorByItem.get(r.sku_id) ?? null;
      addRow(`e|${r.order_number ?? ""}|${color ?? ""}`, {
        color, store: "Ecom", invoice_number: r.order_number ?? null, ar_invoice_id: null,
        customer: null, date: r.order_date ?? null, kind: "ecom",
      }, Number(r.net_qty) || 0, null);
    }
    const rows = [...rowMap.values()].map(({ _amt, _pq, ...r }) => ({ ...r, unit_price: _pq > 0 ? +(_amt / _pq).toFixed(4) : null }))
      .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));

    // Per-colour totals + grand total + colour avg unit price.
    const colorMap = new Map();
    let grand = 0;
    for (const r of rows) {
      const k = r.color ?? "";
      let c = colorMap.get(k);
      if (!c) { c = { color: r.color ?? null, qty: 0, _amt: 0, _pq: 0 }; colorMap.set(k, c); }
      c.qty += r.qty; grand += r.qty;
      if (r.unit_price != null) { c._amt += r.unit_price * r.qty; c._pq += r.qty; }
    }
    const color_totals = [...colorMap.values()]
      .map(({ _amt, _pq, ...c }) => ({ ...c, avg_unit_price: _pq > 0 ? +(_amt / _pq).toFixed(4) : null }))
      .sort((a, b) => b.qty - a.qty);

    return res.status(200).json({ color_totals, grand_total: grand, rows });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
