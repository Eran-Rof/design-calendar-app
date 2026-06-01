// Tangerine T10-4 — Inventory layers rebuild from Xoro snapshot.
//
// Arch reference: docs/tangerine/T10-shadow-mirror-architecture.md §4.3.
//
// rebuildInventoryLayersForDate(supabase, entity_id, snapshot_date) →
//   - reads latest ip_inventory_snapshot per (sku_id, warehouse_code) on/before
//     snapshot_date (warehouse_code is the snapshot's per-store dimension —
//     Tangerine's inventory_layers table has NO warehouse_id column today;
//     the warehouse identity is preserved in the layer's `notes` field so
//     downstream FIFO can be re-bucketed by warehouse when P21 lands).
//   - reads unit cost per sku from ip_item_master.unit_cost (with
//     ip_item_avg_cost.avg_cost as the secondary source when unit_cost is null;
//     the spec referenced an `ip_item_costing` table that does not exist in
//     CURRENT-SCHEMA.md as of P9 — see docs/tangerine/CURRENT-SCHEMA.md).
//   - drops all `source_kind='xoro_mirror_snapshot'` rows for the entity
//     (operator-typed `adjustment`/`ap_invoice`/`opening_balance`/`transfer_in`/
//     `credit_memo_return` rows are NEVER touched — the WHERE clause is keyed
//     on source_kind).
//   - inserts one fresh row per (item_id, warehouse_code) where qty > 0.
//
// Idempotent: re-running on the same snapshot_date is a clean drop-and-rebuild.
//
// PPK grain note: ip_inventory_snapshot.qty_on_hand reflects the physical
// snapshot, which Xoro's REST inventory endpoint returns in native grain
// (packs for PPK styles, eaches for non-PPK). We pass through as-is; if a
// future Xoro feed mixes grains, normalize upstream in the snapshot writer
// rather than here.
//
// SIZE-GRAIN ROUTING (Tangerine-only, per-style, 2026-06-01):
// The Inventory Matrix needs per-SIZE on-hand, but planning's
// ip_inventory_snapshot is COLOR grain. We add a Tangerine-only size-grain
// source, `tangerine_size_onhand` (keyed on the per-SIZE ip_item_master SKU).
// rebuildInventoryLayersForDate now routes PER STYLE:
//   - A style that HAS rows in tangerine_size_onhand (on/before the date)
//     sources its layers from there (per-size, the truth from the Xoro REST
//     feed). The color-grain placeholder SKUs for that style contribute
//     NOTHING — no double-count.
//   - Every other style keeps the existing color-grain ip_inventory_snapshot
//     path, byte-for-byte unchanged.
// Because tangerine_size_onhand starts EMPTY, no style routes to size grain
// and this whole module is a NO-OP until the operator lands size-grain rows
// for a style (the "replace per style" cutover). The drop-and-rebuild of
// source_kind='xoro_mirror_snapshot' layers already gives replace-per-style
// for free: the next rebuild after landing size rows retires that style's
// color-grain mirror layers and emits per-size ones instead.

/**
 * @param {object} supabase    – supabase service-role client
 * @param {string} entity_id   – Tangerine entity id (typically the ROF entity)
 * @param {string} snapshot_date – YYYY-MM-DD; layers are dated at end-of-day UTC
 * @returns {Promise<{
 *   rows_deleted: number,
 *   rows_upserted: number,
 *   rows_skipped_unmatched_sku: number,
 *   rows_skipped_zero_qty: number,
 *   errors: Array<{ stage: string, sku_id?: string, warehouse_code?: string, message: string }>
 * }>}
 */
export async function rebuildInventoryLayersForDate(supabase, entity_id, snapshot_date) {
  if (!supabase) throw new Error("supabase client required");
  if (!entity_id) throw new Error("entity_id required");
  if (!snapshot_date) throw new Error("snapshot_date required");

  const errors = [];
  let rows_deleted = 0;
  let rows_upserted = 0;
  let rows_skipped_unmatched_sku = 0;
  let rows_skipped_zero_qty = 0;

  // --- 0. Read the Tangerine size-grain source first and work out which
  //        STYLES it covers. Those styles route to size-grain layers; every
  //        other style keeps the color-grain ip_inventory_snapshot path.
  //        When tangerine_size_onhand is empty (the default after the
  //        scaffolding migration) sizeGrainStyleIds is empty and the rest of
  //        this function behaves exactly as before — a true no-op.
  let sizeGrainRows = [];
  let sizeGrainStyleIds = new Set();
  let sizeGrainSkuStyleId = new Map(); // sku_id -> style_id (for size SKUs)
  {
    const { data, error } = await supabase
      .from("tangerine_size_onhand")
      .select("item_id, warehouse_code, qty_on_hand, snapshot_date")
      .eq("entity_id", entity_id)
      .lte("snapshot_date", snapshot_date)
      .order("snapshot_date", { ascending: false });
    if (error) {
      // Treat a missing table / read failure as "no size grain configured" —
      // the color-grain path below is the safe fallback. Record and continue.
      errors.push({ stage: "read_size_onhand", message: error.message });
    } else {
      sizeGrainRows = data || [];
    }
  }
  if (sizeGrainRows.length > 0) {
    const sizeItemIds = Array.from(new Set(sizeGrainRows.map((r) => r.item_id).filter(Boolean)));
    for (let i = 0; i < sizeItemIds.length; i += 1000) {
      const slice = sizeItemIds.slice(i, i + 1000);
      const { data, error } = await supabase
        .from("ip_item_master")
        .select("id, style_id")
        .in("id", slice);
      if (error) {
        errors.push({ stage: "read_size_sku_style", message: error.message });
        // Can't safely route without style ids — fall back to color grain
        // entirely so we never half-apply.
        sizeGrainRows = [];
        sizeGrainStyleIds = new Set();
        sizeGrainSkuStyleId = new Map();
        break;
      }
      for (const r of data || []) {
        if (r.style_id) {
          sizeGrainSkuStyleId.set(r.id, r.style_id);
          sizeGrainStyleIds.add(r.style_id);
        }
      }
    }
  }

  // --- 1. Read latest snapshot per (sku_id, warehouse_code) on/before date.
  let snapshotRows;
  {
    const { data, error } = await supabase
      .from("ip_inventory_snapshot")
      .select("sku_id, warehouse_code, qty_on_hand, snapshot_date")
      .lte("snapshot_date", snapshot_date)
      .order("snapshot_date", { ascending: false });
    if (error) {
      errors.push({ stage: "read_snapshot", message: error.message });
      return finalize();
    }
    snapshotRows = data || [];
  }

  // Pick the most-recent COLOR-grain row per (sku_id, warehouse_code).
  const latestByKey = new Map();
  for (const r of snapshotRows) {
    if (!r || !r.sku_id) continue;
    const wh = r.warehouse_code || "DEFAULT";
    const key = `${r.sku_id}|${wh}`;
    if (!latestByKey.has(key)) latestByKey.set(key, r);
  }

  // Pick the most-recent SIZE-grain row per (item_id, warehouse_code).
  const latestSizeByKey = new Map();
  for (const r of sizeGrainRows) {
    if (!r || !r.item_id) continue;
    const wh = r.warehouse_code || "DEFAULT";
    const key = `${r.item_id}|${wh}`;
    if (!latestSizeByKey.has(key)) latestSizeByKey.set(key, { sku_id: r.item_id, warehouse_code: r.warehouse_code, qty_on_hand: r.qty_on_hand, snapshot_date: r.snapshot_date });
  }

  // --- 2. Read unit costs.  Primary: ip_item_master.unit_cost.  Secondary
  //        (fallback when unit_cost is NULL): ip_item_avg_cost.avg_cost keyed
  //        by sku_code.  Both reads filter to the SKUs that actually appear
  //        in the snapshot so we don't pull the whole catalog.
  const itemIds = Array.from(new Set([
    ...Array.from(latestByKey.values()).map((r) => r.sku_id).filter(Boolean),
    ...Array.from(latestSizeByKey.values()).map((r) => r.sku_id).filter(Boolean),
  ]));

  const itemMasterById = new Map();
  if (itemIds.length > 0) {
    const { data, error } = await supabase
      .from("ip_item_master")
      .select("id, sku_code, unit_cost, style_code, style_id")
      .in("id", itemIds);
    if (error) {
      errors.push({ stage: "read_item_master", message: error.message });
      return finalize();
    }
    for (const r of data || []) itemMasterById.set(r.id, r);
  }

  // Fallback cost lookup keyed by sku_code.
  const skuCodes = Array.from(new Set(
    Array.from(itemMasterById.values()).map((r) => r.sku_code).filter(Boolean),
  ));
  const avgCostByCode = new Map();
  if (skuCodes.length > 0) {
    const { data, error } = await supabase
      .from("ip_item_avg_cost")
      .select("sku_code, avg_cost")
      .in("sku_code", skuCodes);
    if (error) {
      // Non-fatal — fallback is best-effort.  Record and continue.
      errors.push({ stage: "read_avg_cost", message: error.message });
    } else {
      for (const r of data || []) avgCostByCode.set(r.sku_code, r.avg_cost);
    }
  }

  // --- 3. Build the new layer payload.
  //        One layer per (item, warehouse). SIZE-grain styles draw from
  //        latestSizeByKey; every COLOR-grain row whose style is size-grain is
  //        SKIPPED here (its quantity is now represented per-size) so the two
  //        grains never coexist for a style → no double-count.
  const receivedAt = `${snapshot_date}T23:59:59.000Z`;
  const newLayers = [];

  const pushLayer = (snap, grain) => {
    const qty = Number(snap.qty_on_hand);
    if (!Number.isFinite(qty) || qty <= 0) {
      rows_skipped_zero_qty++;
      return;
    }
    const master = itemMasterById.get(snap.sku_id);
    if (!master) {
      rows_skipped_unmatched_sku++;
      errors.push({
        stage: "match_sku",
        sku_id: snap.sku_id,
        warehouse_code: snap.warehouse_code,
        message: "no ip_item_master row for snapshot sku_id",
      });
      return;
    }
    let unitCost = null;
    if (master.unit_cost != null) {
      const n = Number(master.unit_cost);
      if (Number.isFinite(n)) unitCost = n;
    }
    if (unitCost == null) {
      const raw = avgCostByCode.get(master.sku_code);
      if (raw != null) {
        const n = Number(raw);
        if (Number.isFinite(n)) unitCost = n;
      }
    }
    if (unitCost == null) unitCost = 0; // last-resort to keep the layer present
    const unit_cost_cents = Math.round(unitCost * 100); // NEAREST cent

    const warehouse_code = snap.warehouse_code || "DEFAULT";
    newLayers.push({
      entity_id,
      item_id: master.id,
      received_at: receivedAt,
      original_qty: qty,
      remaining_qty: qty,
      unit_cost_cents,
      source_kind: "xoro_mirror_snapshot",
      notes: `xoro_mirror_snapshot:${snapshot_date}:wh=${warehouse_code}:grain=${grain}`,
    });
  };

  // COLOR-grain rows — skip any whose style has a size-grain source.
  for (const [, snap] of latestByKey.entries()) {
    const master = itemMasterById.get(snap.sku_id);
    const styleId = master?.style_id || null;
    if (styleId && sizeGrainStyleIds.has(styleId)) continue; // routed to size grain
    pushLayer(snap, "color");
  }

  // SIZE-grain rows — only present for styles the operator has cut over.
  for (const [, snap] of latestSizeByKey.entries()) {
    pushLayer(snap, "size");
  }

  // --- 4. Atomic drop-and-rebuild.  Supabase JS doesn't expose BEGIN/COMMIT,
  //        but DELETE+INSERT scoped to source_kind='xoro_mirror_snapshot' is
  //        idempotent — re-running just regenerates the same rows.  Operator
  //        rows (other source_kind values) are never in the WHERE clause and
  //        cannot be touched.
  {
    const { error, count } = await supabase
      .from("inventory_layers")
      .delete({ count: "exact" })
      .eq("entity_id", entity_id)
      .eq("source_kind", "xoro_mirror_snapshot");
    if (error) {
      errors.push({ stage: "delete_existing_mirror_layers", message: error.message });
      return finalize();
    }
    rows_deleted = Number(count || 0);
  }

  if (newLayers.length > 0) {
    // Chunk inserts at 1000 rows so we stay well under PostgREST's request
    // size limit on the full ROF catalog (~15k SKUs × ~5 warehouses).
    const CHUNK = 1000;
    for (let i = 0; i < newLayers.length; i += CHUNK) {
      const slice = newLayers.slice(i, i + CHUNK);
      const { error } = await supabase.from("inventory_layers").insert(slice);
      if (error) {
        errors.push({
          stage: "insert_new_mirror_layers",
          message: `chunk ${i}-${i + slice.length}: ${error.message}`,
        });
        // Don't keep inserting if the table errored — better to surface a
        // partial-rebuild failure than to silently land half the catalog.
        return finalize();
      }
      rows_upserted += slice.length;
    }
  }

  return finalize();

  function finalize() {
    return {
      rows_deleted,
      rows_upserted,
      rows_skipped_unmatched_sku,
      rows_skipped_zero_qty,
      errors,
    };
  }
}
