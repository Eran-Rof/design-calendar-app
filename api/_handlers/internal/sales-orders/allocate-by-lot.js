// api/internal/sales-orders/allocate-by-lot
//
// Lot numbers — Scenario 5 (ship from available stock by lot). Given a set of
// proposed SO lines ({ item_id, qty }), compute how each line would be filled
// from on-hand inventory BROKEN DOWN BY LOT, following the Scenario-5 rule
// (allocateByLot): fill from as few lots as possible, prefer one lot, and report
// any shortfall so the UI can warn the operator (accept / cancel).
//
// This is a PREVIEW/plan only — it reads inventory_layers and returns a plan; it
// does NOT write SO lines or reserve stock. The SO-entry UI turns an accepted
// plan into per-lot SO lines (each carrying lot_number) at save time.
//
// NOTE: availability here is raw on-hand per lot (Σ inventory_layers.remaining_qty);
// it does not yet net out open allocations per lot (reservations aren't lot-
// tracked today — they soft-reserve at the item level). A future refinement can
// subtract per-lot reservations once allocations carry a lot.

import { createClient } from "@supabase/supabase-js";
import { allocateByLot, bucketsFromLayers } from "../../../_lib/inventory/lotAllocation.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntity(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data || null;
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
  const rawLines = Array.isArray(body?.lines) ? body.lines : [];
  // Normalize + collapse duplicate item_ids (sum their qty) so a line that
  // appears twice is allocated against the lot pool once.
  const needByItem = new Map();
  for (const l of rawLines) {
    const id = l?.item_id;
    const qty = Math.floor(Number(l?.qty) || 0);
    if (!id || !UUID_RE.test(String(id)) || qty <= 0) continue;
    needByItem.set(id, (needByItem.get(id) || 0) + qty);
  }
  const itemIds = [...needByItem.keys()];
  if (itemIds.length === 0) return res.status(400).json({ error: "lines: at least one { item_id, qty>0 } required" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // On-hand layers (with remaining qty) for these items, grouped per item.
  const { data: layers, error: lErr } = await admin
    .from("inventory_layers")
    .select("item_id, lot_number, remaining_qty")
    .eq("entity_id", entity.id)
    .in("item_id", itemIds)
    .gt("remaining_qty", 0);
  if (lErr) return res.status(500).json({ error: lErr.message });
  const layersByItem = new Map();
  for (const row of layers || []) {
    if (!layersByItem.has(row.item_id)) layersByItem.set(row.item_id, []);
    layersByItem.get(row.item_id).push(row);
  }

  // SKU decomposition for human-readable warning labels.
  const { data: skus } = await admin
    .from("ip_item_master")
    .select("id, style_code, color, size, inseam, sku_code")
    .in("id", itemIds);
  const skuById = new Map((skus || []).map((s) => [s.id, s]));

  const lines = itemIds.map((itemId) => {
    const need = needByItem.get(itemId);
    const buckets = bucketsFromLayers(layersByItem.get(itemId) || []);
    const plan = allocateByLot(need, buckets);
    const s = skuById.get(itemId) || null;
    return {
      item_id: itemId,
      sku_code: s?.sku_code ?? null,
      style_code: s?.style_code ?? null,
      color: s?.color ?? null,
      size: s?.size ?? null,
      inseam: s?.inseam ?? null,
      qty_ordered: need,
      picks: plan.picks,          // [{ lot_number, qty }]
      filled: plan.filled,
      shortfall: plan.shortfall,
    };
  });

  const fully = lines.every((l) => l.shortfall === 0);
  const shortLines = lines.filter((l) => l.shortfall > 0);
  return res.status(200).json({
    fully_allocatable: fully,
    lines,
    shortfall_count: shortLines.length,
    message: fully
      ? "All lines can be filled from stock by lot."
      : `${shortLines.length} line(s) cannot be fully filled from stock.`,
  });
}
