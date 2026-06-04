// api/_lib/planning-supply-tangerine.js
//
// M31 / P17 direction B — populate the planning supply input tables from
// native Tangerine ERP data, tagged `source='tangerine'`, so a planning run
// configured with `supply_source='tangerine'` reconciles against Tangerine's
// own on-hand + open POs instead of the Xoro/ATS mirror.
//
//   on-hand   ← inventory_layers (Σ remaining_qty by item_id × location) → ip_inventory_snapshot
//   open POs  ← purchase_orders (issued/in_transit) + purchase_order_lines → ip_open_purchase_orders
//
// Mapping is direct: inventory_layers.item_id = purchase_order_lines.inventory_item_id =
// ip_item_master.id = planning sku_id (no lookup). Pure transforms are split
// out for unit testing; the exported sync fns do the IO. Mirrors the
// framework-agnostic split of planning-sync.js — no res/req args here.

// Native PO statuses that represent still-incoming supply.
export const OPEN_PO_STATUSES = ["issued", "in_transit"];

// Σ remaining_qty by (item_id, warehouse_code). `codeByLocId` maps a layer's
// location_id → inventory_locations.code; unknown/blank collapses to 'UNKNOWN'.
// Layers with non-positive remaining are dropped.
export function aggregateOnHandLayers(layers, codeByLocId) {
  const map = new Map();
  for (const l of layers || []) {
    const qty = Number(l.remaining_qty) || 0;
    if (qty <= 0 || !l.item_id) continue;
    const code = (codeByLocId && codeByLocId.get(l.location_id)) || "UNKNOWN";
    const key = `${l.item_id}|${code}`;
    const e = map.get(key) || { sku_id: l.item_id, warehouse_code: code, qty_on_hand: 0 };
    e.qty_on_hand += qty;
    map.set(key, e);
  }
  return [...map.values()];
}

// Build ip_open_purchase_orders rows from open POs + their lines.
// linesByPo: Map<purchase_order_id, line[]>. Drops fully-received / zero-open
// lines and lines without an item.
export function buildOpenPoRows(pos, linesByPo) {
  const rows = [];
  for (const po of pos || []) {
    const lines = (linesByPo && linesByPo.get(po.id)) || [];
    for (const ln of lines) {
      if (!ln.inventory_item_id) continue;
      const ordered = Number(ln.qty_ordered) || 0;
      const received = Number(ln.qty_received) || 0;
      const open = ordered - received;
      if (open <= 0) continue;
      rows.push({
        sku_id: ln.inventory_item_id,
        vendor_id: po.vendor_id || null,
        po_number: po.po_number || `PO-${String(po.id).slice(0, 8)}`,
        po_line_number: String(ln.line_number),
        order_date: po.order_date || null,
        expected_date: po.expected_date || null,
        qty_ordered: ordered,
        qty_received: received,
        qty_open: open,
        unit_cost: (Number(ln.unit_cost_cents) || 0) / 100,
        currency: po.currency || "USD",
        status: po.status,
        source: "tangerine",
        source_line_key: `${po.id}:${ln.line_number}`,
        channel: null,
      });
    }
  }
  return rows;
}

// ── IO ──────────────────────────────────────────────────────────────────────

async function fetchAllPaged(admin, table, select, build) {
  const out = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let q = admin.from(table).select(select).range(from, from + pageSize - 1);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
  }
  return out;
}

export async function syncOnHandFromTangerine(admin, { snapshotDate } = {}) {
  const date = snapshotDate || new Date().toISOString().slice(0, 10);
  const { data: locs } = await admin.from("inventory_locations").select("id, code");
  const codeByLocId = new Map((locs || []).map((l) => [l.id, l.code]));

  const layers = await fetchAllPaged(admin, "inventory_layers", "item_id, remaining_qty, location_id",
    (q) => q.gt("remaining_qty", 0));

  const agg = aggregateOnHandLayers(layers, codeByLocId);
  const rows = agg.map((r) => ({
    sku_id: r.sku_id, warehouse_code: r.warehouse_code, snapshot_date: date,
    qty_on_hand: r.qty_on_hand, qty_available: r.qty_on_hand, qty_committed: 0,
    qty_on_order: 0, qty_in_transit: 0, source: "tangerine",
  }));

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin.from("ip_inventory_snapshot")
      .upsert(chunk, { onConflict: "sku_id,warehouse_code,snapshot_date,source" });
    if (error) throw new Error(`ip_inventory_snapshot upsert failed: ${error.message}`);
    upserted += chunk.length;
  }
  return {
    snapshot_date: date,
    layers_scanned: layers.length,
    snapshot_rows_upserted: upserted,
    skus: new Set(rows.map((r) => r.sku_id)).size,
    total_units: rows.reduce((s, r) => s + r.qty_on_hand, 0),
  };
}

export async function syncOpenPosFromTangerine(admin) {
  const pos = await fetchAllPaged(admin, "purchase_orders",
    "id, vendor_id, po_number, order_date, expected_date, status, currency",
    (q) => q.in("status", OPEN_PO_STATUSES));

  let rows = [];
  if (pos.length) {
    const poIds = pos.map((p) => p.id);
    const lines = [];
    for (let i = 0; i < poIds.length; i += 100) {
      const { data, error } = await admin.from("purchase_order_lines")
        .select("purchase_order_id, line_number, inventory_item_id, qty_ordered, qty_received, unit_cost_cents")
        .in("purchase_order_id", poIds.slice(i, i + 100));
      if (error) throw new Error(`purchase_order_lines read failed: ${error.message}`);
      if (data) lines.push(...data);
    }
    const linesByPo = new Map();
    for (const ln of lines) {
      const a = linesByPo.get(ln.purchase_order_id) || [];
      a.push(ln);
      linesByPo.set(ln.purchase_order_id, a);
    }
    rows = buildOpenPoRows(pos, linesByPo);
  }

  // Full rebuild of the tangerine open-PO set (delete-then-insert) so closed /
  // received POs don't linger. Only touches source='tangerine' rows.
  const { error: delErr } = await admin.from("ip_open_purchase_orders").delete().eq("source", "tangerine");
  if (delErr) throw new Error(`ip_open_purchase_orders prune failed: ${delErr.message}`);

  const stamp = new Date().toISOString();
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, last_seen_at: stamp }));
    const { error } = await admin.from("ip_open_purchase_orders").insert(chunk);
    if (error) throw new Error(`ip_open_purchase_orders insert failed: ${error.message}`);
    inserted += chunk.length;
  }
  return { open_pos_scanned: pos.length, open_po_rows_inserted: inserted };
}
