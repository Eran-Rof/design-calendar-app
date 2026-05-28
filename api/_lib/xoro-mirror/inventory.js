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

  // Pick the most-recent row per (sku_id, warehouse_code).
  const latestByKey = new Map();
  for (const r of snapshotRows) {
    if (!r || !r.sku_id) continue;
    const wh = r.warehouse_code || "DEFAULT";
    const key = `${r.sku_id}|${wh}`;
    if (!latestByKey.has(key)) latestByKey.set(key, r);
  }

  // --- 2. Read unit costs.  Primary: ip_item_master.unit_cost.  Secondary
  //        (fallback when unit_cost is NULL): ip_item_avg_cost.avg_cost keyed
  //        by sku_code.  Both reads filter to the SKUs that actually appear
  //        in the snapshot so we don't pull the whole catalog.
  const itemIds = Array.from(new Set(
    Array.from(latestByKey.values()).map((r) => r.sku_id).filter(Boolean),
  ));

  const itemMasterById = new Map();
  if (itemIds.length > 0) {
    const { data, error } = await supabase
      .from("ip_item_master")
      .select("id, sku_code, unit_cost, style_code")
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
  const receivedAt = `${snapshot_date}T23:59:59.000Z`;
  const newLayers = [];
  for (const [key, snap] of latestByKey.entries()) {
    const qty = Number(snap.qty_on_hand);
    if (!Number.isFinite(qty) || qty <= 0) {
      rows_skipped_zero_qty++;
      continue;
    }
    const master = itemMasterById.get(snap.sku_id);
    if (!master) {
      // Snapshot references an unknown ip_item_master.id — log and skip.
      rows_skipped_unmatched_sku++;
      errors.push({
        stage: "match_sku",
        sku_id: snap.sku_id,
        warehouse_code: snap.warehouse_code,
        message: "no ip_item_master row for snapshot sku_id",
      });
      continue;
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
      notes: `xoro_mirror_snapshot:${snapshot_date}:wh=${warehouse_code}`,
    });
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
