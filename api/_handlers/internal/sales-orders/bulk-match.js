// api/internal/sales-orders/bulk-match
//
// Lot numbers — Scenario 4.2. Given a distro sales order, find the open BULK
// orders for the same customer that it overlaps by style/color, with a % match
// and a per-style/color breakdown. The UI surfaces this when a distro is saved
// ("distro matches bulk NNN — cancel the bulk?") and to view/download details.
//
// Read-only preview. Cancelling the bulk is a normal SO status PATCH; this
// endpoint never mutates.
//
// Body: { sales_order_id }  (the distro / incoming customer PO)

import { createClient } from "@supabase/supabase-js";
import { computeBulkMatch } from "../../../_lib/sales/bulkMatch.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ["draft", "confirmed", "allocated", "fulfilling"]; // a bulk worth cancelling

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

// Load a SO's lines as { style_code, color, qty } via ip_item_master decoration.
async function decoratedLines(admin, soId, skuCache) {
  const { data: lines } = await admin.from("sales_order_lines")
    .select("inventory_item_id, qty_ordered").eq("sales_order_id", soId);
  const out = [];
  for (const l of lines || []) {
    const sku = l.inventory_item_id ? skuCache.get(l.inventory_item_id) : null;
    out.push({ style_code: sku?.style_code ?? null, color: sku?.color ?? null, qty: Number(l.qty_ordered) || 0 });
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const soId = body?.sales_order_id;
  if (!soId || !UUID_RE.test(String(soId))) return res.status(400).json({ error: "sales_order_id (uuid) required" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: distro, error: dErr } = await admin.from("sales_orders")
    .select("id, entity_id, customer_id, customer_po, so_number, is_bulk_order").eq("id", soId).maybeSingle();
  if (dErr) return res.status(500).json({ error: dErr.message });
  if (!distro) return res.status(404).json({ error: "Sales order not found" });
  // A bulk order isn't itself a distro — nothing to match.
  if (distro.is_bulk_order) return res.status(200).json({ matches: [], message: "This is a bulk order." });

  // Candidate bulk SOs: same customer, flagged bulk, still open, not this SO.
  const { data: bulks } = await admin.from("sales_orders")
    .select("id, so_number, customer_po, status")
    .eq("entity_id", distro.entity_id).eq("customer_id", distro.customer_id)
    .eq("is_bulk_order", true).in("status", OPEN_STATUSES).neq("id", soId);
  if (!bulks || bulks.length === 0) return res.status(200).json({ matches: [], message: "No open bulk orders for this customer." });

  // Decorate all involved lines in one ip_item_master fetch.
  const soIds = [soId, ...bulks.map((b) => b.id)];
  const { data: allLines } = await admin.from("sales_order_lines")
    .select("inventory_item_id").in("sales_order_id", soIds);
  const itemIds = [...new Set((allLines || []).map((l) => l.inventory_item_id).filter(Boolean))];
  const skuCache = new Map();
  if (itemIds.length) {
    const { data: skus } = await admin.from("ip_item_master").select("id, style_code, color").in("id", itemIds);
    for (const s of skus || []) skuCache.set(s.id, s);
  }

  const distroLines = await decoratedLines(admin, soId, skuCache);
  const matches = [];
  for (const b of bulks) {
    const bulkLines = await decoratedLines(admin, b.id, skuCache);
    const m = computeBulkMatch(bulkLines, distroLines);
    if (m.matched_units > 0) {
      matches.push({ id: b.id, so_number: b.so_number, customer_po: b.customer_po, status: b.status, ...m });
    }
  }
  matches.sort((a, b) => b.matched_units - a.matched_units);

  return res.status(200).json({
    distro: { id: distro.id, so_number: distro.so_number, customer_po: distro.customer_po },
    matches,
    message: matches.length ? `${matches.length} bulk order(s) match this distro.` : "No bulk order overlaps this distro.",
  });
}
