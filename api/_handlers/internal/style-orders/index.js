// api/internal/style-orders?style_id=<uuid>&view=<so|po|invoices>
//
// Row-driven drill list for the Inventory Matrix's SO / PO / Invoices views.
// Given a style, resolves the style's inventory item ids (ip_item_master rows
// for that style_id), finds the order/invoice headers whose LINES reference one
// of those items, and returns enriched header rows with the *_id fields already
// resolved to human labels (customer/vendor name, order/invoice number) so the
// UI never renders a raw uuid.
//
//   view=so        → sales orders containing the style (ALL statuses)
//                    rows: { id, so_number, customer_id, customer_name,
//                            requested_ship_date, cancel_date, status,
//                            total_cents, qty_for_style }
//   view=po        → purchase orders containing the style
//                    rows: { id, po_number, vendor_id, vendor_name,
//                            expected_date, status, total_cents, qty_for_style }
//   view=invoices  → AR customer invoices containing the style
//                    rows: { id, invoice_number, customer_id, customer_name,
//                            invoice_date, gl_status, total_amount_cents,
//                            qty_for_style }
//
// Entity scoped (ROF default). Read-only. No migration — reuses existing tables.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWS = ["so", "po", "invoices"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function entityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

// Resolve the style's inventory item ids (the SKUs that order/invoice lines
// reference via inventory_item_id). Same source the matrix uses.
async function styleItemIds(admin, eid, styleId) {
  const { data } = await admin
    .from("ip_item_master")
    .select("id")
    .eq("entity_id", eid)
    .eq("style_id", styleId);
  return (data || []).map((r) => r.id);
}

// Build a id→name lookup for a party table (customers / vendors).
async function nameMap(admin, table, ids) {
  const out = new Map();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  const { data } = await admin.from(table).select("id, name").in("id", uniq);
  for (const r of data || []) out.set(r.id, r.name || null);
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const styleId = (url.searchParams.get("style_id") || "").trim();
  const view = (url.searchParams.get("view") || "").trim().toLowerCase();
  if (!UUID_RE.test(styleId)) return res.status(400).json({ error: "style_id (uuid) required" });
  if (!VIEWS.includes(view)) return res.status(400).json({ error: `view must be one of ${VIEWS.join(", ")}` });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const itemIds = await styleItemIds(admin, eid, styleId);
  if (itemIds.length === 0) return res.status(200).json([]);

  try {
    if (view === "so") return res.status(200).json(await buildSoRows(admin, eid, itemIds));
    if (view === "po") return res.status(200).json(await buildPoRows(admin, eid, itemIds));
    return res.status(200).json(await buildInvoiceRows(admin, eid, itemIds));
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ── SO view ───────────────────────────────────────────────────────────────────
async function buildSoRows(admin, eid, itemIds) {
  const { data: lines, error } = await admin
    .from("sales_order_lines")
    .select("sales_order_id, qty_ordered, inventory_item_id")
    .in("inventory_item_id", itemIds);
  if (error) throw new Error(error.message);
  const qtyByHeader = new Map();
  for (const l of lines || []) {
    qtyByHeader.set(l.sales_order_id, (qtyByHeader.get(l.sales_order_id) || 0) + Number(l.qty_ordered || 0));
  }
  const headerIds = [...qtyByHeader.keys()];
  if (headerIds.length === 0) return [];
  const { data: headers, error: hErr } = await admin
    .from("sales_orders")
    .select("id, so_number, customer_id, requested_ship_date, cancel_date, status, total_cents, order_date")
    .eq("entity_id", eid)
    .in("id", headerIds)
    .order("order_date", { ascending: false });
  if (hErr) throw new Error(hErr.message);
  const custNames = await nameMap(admin, "customers", (headers || []).map((h) => h.customer_id));
  return (headers || []).map((h) => ({
    id: h.id,
    so_number: h.so_number,
    customer_id: h.customer_id,
    customer_name: custNames.get(h.customer_id) || null,
    requested_ship_date: h.requested_ship_date,
    cancel_date: h.cancel_date,
    status: h.status,
    total_cents: h.total_cents,
    qty_for_style: qtyByHeader.get(h.id) || 0,
  }));
}

// ── PO view ───────────────────────────────────────────────────────────────────
async function buildPoRows(admin, eid, itemIds) {
  const { data: lines, error } = await admin
    .from("purchase_order_lines")
    .select("purchase_order_id, qty_ordered, inventory_item_id")
    .in("inventory_item_id", itemIds);
  if (error) throw new Error(error.message);
  const qtyByHeader = new Map();
  for (const l of lines || []) {
    qtyByHeader.set(l.purchase_order_id, (qtyByHeader.get(l.purchase_order_id) || 0) + Number(l.qty_ordered || 0));
  }
  const headerIds = [...qtyByHeader.keys()];
  if (headerIds.length === 0) return [];
  const { data: headers, error: hErr } = await admin
    .from("purchase_orders")
    .select("id, po_number, vendor_id, expected_date, status, total_cents, order_date")
    .eq("entity_id", eid)
    .in("id", headerIds)
    .order("order_date", { ascending: false });
  if (hErr) throw new Error(hErr.message);
  const vendorNames = await nameMap(admin, "vendors", (headers || []).map((h) => h.vendor_id));
  return (headers || []).map((h) => ({
    id: h.id,
    po_number: h.po_number,
    vendor_id: h.vendor_id,
    vendor_name: vendorNames.get(h.vendor_id) || null,
    expected_date: h.expected_date,
    status: h.status,
    total_cents: h.total_cents,
    qty_for_style: qtyByHeader.get(h.id) || 0,
  }));
}

// ── Invoices view (AR customer invoices) ───────────────────────────────────────
async function buildInvoiceRows(admin, eid, itemIds) {
  const { data: lines, error } = await admin
    .from("ar_invoice_lines")
    .select("ar_invoice_id, quantity, inventory_item_id")
    .in("inventory_item_id", itemIds);
  if (error) throw new Error(error.message);
  const qtyByHeader = new Map();
  for (const l of lines || []) {
    qtyByHeader.set(l.ar_invoice_id, (qtyByHeader.get(l.ar_invoice_id) || 0) + Number(l.quantity || 0));
  }
  const headerIds = [...qtyByHeader.keys()];
  if (headerIds.length === 0) return [];
  const { data: headers, error: hErr } = await admin
    .from("ar_invoices")
    .select("id, invoice_number, customer_id, invoice_date, gl_status, total_amount_cents")
    .eq("entity_id", eid)
    .in("id", headerIds)
    .order("invoice_date", { ascending: false });
  if (hErr) throw new Error(hErr.message);
  const custNames = await nameMap(admin, "customers", (headers || []).map((h) => h.customer_id));
  return (headers || []).map((h) => ({
    id: h.id,
    invoice_number: h.invoice_number,
    customer_id: h.customer_id,
    customer_name: custNames.get(h.customer_id) || null,
    invoice_date: h.invoice_date,
    gl_status: h.gl_status,
    total_amount_cents: h.total_amount_cents,
    qty_for_style: qtyByHeader.get(h.id) || 0,
  }));
}
