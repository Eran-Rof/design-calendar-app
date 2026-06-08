// api/_lib/tplInventoryRecon.js
//
// Shared 3PL inventory reconciliation: given a 3PL's on-hand lines, store a
// dated snapshot and compute per-SKU differences vs Tangerine on-hand
// (inventory_layers) at the provider's location AND total. Used by both the
// manual ingest endpoint (internal/edi/tpl/[provider_id]/inventory-advice) and
// the nightly SFTP-pull cron (cron/tpl-inventory-pull).
//
// `lines`: [{ sku, qty_on_hand }] (already parsed from 846 / CSV / JSON).

// CSV → [{ sku, qty_on_hand }]. "sku,qty" rows; skips a header / non-numeric row.
export function parseInventoryCsv(text) {
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cells.length < 2) continue;
    const sku = cells[0];
    const qty = Number(cells[1]);
    if (!sku || !Number.isFinite(qty)) continue;
    out.push({ sku, qty_on_hand: qty });
  }
  return out;
}

// Sum inventory_layers.remaining_qty for item ids → { total, atLoc } maps.
async function fetchOnHand(admin, entityId, itemIds, locationId) {
  const total = new Map();
  const atLoc = new Map();
  for (let i = 0; i < itemIds.length; i += 400) {
    const chunk = itemIds.slice(i, i + 400);
    const { data } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty, location_id")
      .eq("entity_id", entityId)
      .in("item_id", chunk)
      .gt("remaining_qty", 0);
    for (const l of data || []) {
      const q = Number(l.remaining_qty) || 0;
      total.set(l.item_id, (total.get(l.item_id) || 0) + q);
      if (locationId && l.location_id === locationId) atLoc.set(l.item_id, (atLoc.get(l.item_id) || 0) + q);
    }
  }
  return { total, atLoc };
}

/**
 * Store a snapshot for `provider` and compute its differences vs Tangerine.
 * @returns summary { ok, snapshot_id, lines, matched_skus, unmatched_skus,
 *   differences_recorded, mismatch_vs_location, mismatch_vs_total, has_location, message }
 */
export async function reconcileSnapshot(admin, provider, lines, { source = "manual", raw = null, snapshotDate } = {}) {
  const date = snapshotDate && /^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) ? snapshotDate : new Date().toISOString().slice(0, 10);

  // Collapse duplicate SKUs (sum).
  const bySku = new Map();
  for (const l of lines || []) {
    const sku = String(l.sku ?? l.sku_code ?? "").trim();
    if (!sku) continue;
    bySku.set(sku, (bySku.get(sku) || 0) + (Number(l.qty_on_hand ?? l.qty ?? 0) || 0));
  }
  const skuList = [...bySku.keys()];
  if (skuList.length === 0) return { ok: false, error: "No inventory lines to reconcile." };

  // Resolve sku_code → item id (chunked).
  const itemBySku = new Map();
  for (let i = 0; i < skuList.length; i += 400) {
    const { data } = await admin.from("ip_item_master").select("id, sku_code").eq("entity_id", provider.entity_id).in("sku_code", skuList.slice(i, i + 400));
    for (const r of data || []) itemBySku.set(r.sku_code, r.id);
  }
  const matched = skuList.filter((s) => itemBySku.has(s)).length;

  // Snapshot + lines.
  const { data: snap, error: snapErr } = await admin.from("tpl_inventory_snapshots").insert({
    entity_id: provider.entity_id, tpl_provider_id: provider.id, snapshot_date: date,
    source, line_count: skuList.length, matched_count: matched,
    raw_content: raw && raw.length < 500000 ? raw : null,
  }).select("id").single();
  if (snapErr) return { ok: false, error: `Snapshot store failed: ${snapErr.message}` };

  const lineRows = skuList.map((sku) => ({ snapshot_id: snap.id, sku_code: sku, item_id: itemBySku.get(sku) || null, qty_on_hand: bySku.get(sku) }));
  for (let i = 0; i < lineRows.length; i += 500) await admin.from("tpl_inventory_snapshot_lines").insert(lineRows.slice(i, i + 500));

  if (source === "edi846" && raw) {
    await admin.from("edi_messages").insert({
      vendor_id: null, direction: "inbound", transaction_set: "846", status: "processed",
      raw_content: raw, parsed_content: { line_count: skuList.length, matched }, tpl_provider_id: provider.id,
    });
  }

  // Reconcile vs Tangerine on-hand.
  const matchedItemIds = [...itemBySku.values()];
  const { total, atLoc } = await fetchOnHand(admin, provider.entity_id, matchedItemIds, provider.location_id);

  const diffRows = [];
  for (const sku of skuList) {
    const itemId = itemBySku.get(sku) || null;
    diffRows.push({
      entity_id: provider.entity_id, snapshot_id: snap.id, tpl_provider_id: provider.id, snapshot_date: date,
      sku_code: sku, item_id: itemId, qty_3pl: bySku.get(sku),
      qty_tangerine_location: itemId ? (atLoc.get(itemId) || 0) : 0,
      qty_tangerine_total: itemId ? (total.get(itemId) || 0) : 0,
      direction: "both",
    });
  }

  // SKUs Tangerine holds at the 3PL location that the 3PL didn't report.
  if (provider.location_id) {
    const reported = new Set(matchedItemIds);
    const { data: locRows } = await admin.from("inventory_layers")
      .select("item_id, remaining_qty").eq("entity_id", provider.entity_id).eq("location_id", provider.location_id).gt("remaining_qty", 0);
    const locSum = new Map();
    for (const l of locRows || []) locSum.set(l.item_id, (locSum.get(l.item_id) || 0) + (Number(l.remaining_qty) || 0));
    const missing = [...locSum.keys()].filter((id) => !reported.has(id));
    if (missing.length) {
      const skuByItem = new Map();
      for (let i = 0; i < missing.length; i += 400) {
        const { data } = await admin.from("ip_item_master").select("id, sku_code").in("id", missing.slice(i, i + 400));
        for (const r of data || []) skuByItem.set(r.id, r.sku_code);
      }
      const tot = await fetchOnHand(admin, provider.entity_id, missing, provider.location_id);
      for (const id of missing) {
        diffRows.push({
          entity_id: provider.entity_id, snapshot_id: snap.id, tpl_provider_id: provider.id, snapshot_date: date,
          sku_code: skuByItem.get(id) || "(unknown)", item_id: id, qty_3pl: 0,
          qty_tangerine_location: locSum.get(id) || 0, qty_tangerine_total: tot.total.get(id) || 0,
          direction: "only_tangerine",
        });
      }
    }
  }

  for (let i = 0; i < diffRows.length; i += 500) await admin.from("tpl_inventory_differences").insert(diffRows.slice(i, i + 500));

  const mismatchLoc = diffRows.filter((d) => Number(d.qty_3pl) !== Number(d.qty_tangerine_location)).length;
  const mismatchTot = diffRows.filter((d) => Number(d.qty_3pl) !== Number(d.qty_tangerine_total)).length;
  return {
    ok: true, snapshot_id: snap.id, snapshot_date: date, source,
    lines: skuList.length, matched_skus: matched, unmatched_skus: skuList.length - matched,
    differences_recorded: diffRows.length, mismatch_vs_location: mismatchLoc, mismatch_vs_total: mismatchTot,
    has_location: !!provider.location_id,
    message: `Snapshot ingested for ${provider.name} (${skuList.length} SKUs, ${matched} matched). ${mismatchTot} differ vs Tangerine total on-hand.`,
  };
}
