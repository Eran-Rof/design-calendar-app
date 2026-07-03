// api/_lib/inventory/onhand-sync.js
//
// Phantom on-hand recurrence fix (Option A). The Inventory Matrix on-hand is
// `Σ inventory_layers.remaining_qty`, but for Xoro-sourced styles those layers
// were a one-time 2026-05-27 `opening_balance` seed. Xoro sales (xoro-sales-sync)
// only write ip_sales_history and never deplete layers, so the seed froze and
// phantom on-hand accumulated. Meanwhile the nightly ATS feed refreshes the TRUE
// on-hand into `ip_inventory_snapshot` (source='manual'). This job re-points the
// synced on-hand layers at that truth every night, in a dedicated source_kind.
//
// Invariants (so it never destroys real inventory):
//   • Acts ONLY on SKUs present in the LATEST manual snapshot date (the current
//     active catalog). A SKU absent from that feed (sold-through / discontinued,
//     e.g. the CYB-family) is left untouched — its corrected on-hand stands.
//   • Manages a style ONLY when every layer it has is Xoro-seeded
//     (opening_balance) or our own (xoro_onhand_sync). The moment a style is
//     touched by a native event (ap_invoice / po_receipt / adjustment /
//     manufacture / transfer_in / credit_memo_return) or the by-size cutover
//     (xoro_rest_size), it is SKIPPED — the mirror must not double-count those.
//   • Owns ONLY source_kind='xoro_onhand_sync' for inserts, and only zeroes the
//     legacy 'opening_balance' seed on the items it manages. Native FIFO layers
//     are never in any WHERE clause.

const SYNC_KIND = "xoro_onhand_sync";
const SEED_KIND = "opening_balance";

// A style is "Xoro-mirror managed" only if it carries no layer of any other
// kind. These two are the kinds the mirror itself is allowed to own/replace.
const MIRROR_OWNED_KINDS = new Set([SEED_KIND, SYNC_KIND]);

// The manual ATS feed only writes warehouse_code='DEFAULT'; map it (and the
// tangerine writeback's 'MAIN_WH') to the canonical Main Warehouse location.
const SNAPSHOT_WH_TO_LOCATION_CODE = { DEFAULT: "WH-00000", MAIN_WH: "WH-00000" };

function looseKey(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Pure planner — no IO. Given the feed rows and resolved context, produce the
 * set of sync layers to insert and the items whose seed must be zeroed.
 *
 * @returns {{ insert: Array, touchItemIds: Set<string>, counts: object }}
 */
export function planOnHandSync({ feedRows, masterById, managedStyleIds, avgCostCentsByCode, locationIdByCode, receivedAt }) {
  const insert = [];
  const touchItemIds = new Set();
  const counts = {
    feed_rows: feedRows.length,
    planned_layers: 0,
    skipped_no_master: 0,
    skipped_not_managed: 0,
    skipped_no_location: 0,
    managed_zero_qty: 0,
  };
  for (const row of feedRows) {
    const m = masterById.get(row.sku_id);
    if (!m) { counts.skipped_no_master++; continue; }
    if (!managedStyleIds.has(m.style_id)) { counts.skipped_not_managed++; continue; }
    const locCode = SNAPSHOT_WH_TO_LOCATION_CODE[row.warehouse_code] || null;
    const locationId = locCode ? locationIdByCode.get(locCode) : null;
    if (!locationId) { counts.skipped_no_location++; continue; }

    // Managed item: its seed will be zeroed and prior sync layers replaced even
    // when the feed qty is 0 (that's exactly how a sold-through style lands at 0).
    touchItemIds.add(m.id);

    const qty = Number(row.qty_on_hand);
    if (!Number.isFinite(qty) || qty <= 0) { counts.managed_zero_qty++; continue; }

    const cents =
      avgCostCentsByCode.get(m.sku_code) ??
      avgCostCentsByCode.get(`loose:${looseKey(m.sku_code)}`) ??
      0;
    insert.push({
      item_id: m.id,
      location_id: locationId,
      received_at: receivedAt,
      original_qty: qty,
      remaining_qty: qty,
      unit_cost_cents: cents,
      source_kind: SYNC_KIND,
      notes: `xoro_onhand_sync:${receivedAt}:wh=${row.warehouse_code}:grain=color`,
    });
    counts.planned_layers++;
  }
  return { insert, touchItemIds, counts };
}

// ── IO helpers ───────────────────────────────────────────────────────────────

async function fetchAllPaged(admin, table, select, build) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = admin.from(table).select(select).range(from, from + page - 1);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

async function resolveEntityId(admin) {
  const { data } = await admin.rpc("rof_entity_id");
  if (data) return data;
  const { data: e } = await admin.from("entities").select("id").limit(1).maybeSingle();
  return e?.id || null;
}

async function latestManualDate(admin) {
  const { data } = await admin
    .from("ip_inventory_snapshot")
    .select("snapshot_date")
    .eq("source", "manual")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.snapshot_date || null;
}

// Of `feedStyleIds`, the styles that carry ONLY mirror-owned layer kinds
// (opening_balance / xoro_onhand_sync) or no layers at all. Any style with a
// native-event or by-size (xoro_rest_size) layer is excluded.
//
// Cap-safe by construction: we scan the DISQUALIFYING layers globally
// (source_kind NOT mirror-owned — a small, paginated set) and map them to
// styles, instead of fetching every SKU of every feed style. The naive approach
// fetched `ip_item_master .in(style_id, 200-chunk)` (~2k rows) and the layers
// per chunk (~thousands) — both blew past the PostgREST 1000-row cap, so a
// by-size style's size SKUs / their xoro_rest_size layers were silently dropped
// and the style wrongly stayed "managed" (inflating its on-hand: 771 managed vs
// the true 199). See [[project_postgrest_1000_row_cap]].
export async function computeManagedStyleIds(admin, entityId, feedStyleIds) {
  const feedSet = new Set(feedStyleIds);
  if (feedSet.size === 0) return new Set();
  const NOT_MIRROR = `(${[...MIRROR_OWNED_KINDS].join(",")})`;
  const PAGE = 1000;

  // 1. Every item_id that carries a non-mirror layer (paginated, filtered).
  const disqItemIds = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("inventory_layers")
      .select("item_id")
      .eq("entity_id", entityId)
      .not("source_kind", "in", NOT_MIRROR)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`inventory_layers disqualify scan failed: ${error.message}`);
    for (const r of data || []) disqItemIds.add(r.item_id);
    if (!data || data.length < PAGE) break;
  }

  // 2. Map those items to their styles (chunk ≤ 300 ⇒ under the cap).
  const disqStyles = new Set();
  const ids = [...disqItemIds];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const { data, error } = await admin.from("ip_item_master").select("style_id").in("id", chunk);
    if (error) throw new Error(`disqualify style map failed: ${error.message}`);
    for (const r of data || []) if (r.style_id) disqStyles.add(r.style_id);
  }

  // 3. Managed = feed styles with no disqualifying layer.
  const managed = new Set();
  for (const sid of feedSet) if (!disqStyles.has(sid)) managed.add(sid);
  return managed;
}

async function fetchAvgCostByCode(admin, skuCodes) {
  const map = new Map();
  const stems = [...new Set(skuCodes.map((c) => String(c || "").split("-")[0].trim()).filter(Boolean))];
  for (let i = 0; i < stems.length; i += 25) {
    const orFilter = stems.slice(i, i + 25).map((st) => `sku_code.like.${st}-%`).join(",");
    const { data, error } = await admin.from("ip_item_avg_cost").select("sku_code, avg_cost").or(orFilter);
    if (error) continue; // cost is best-effort; degrade to 0
    for (const r of data || []) {
      if (r.avg_cost == null) continue;
      const cents = Math.round(Number(r.avg_cost) * 100);
      map.set(r.sku_code, cents);
      const lk = `loose:${looseKey(r.sku_code)}`;
      if (!map.has(lk)) map.set(lk, cents);
    }
  }
  return map;
}

/**
 * Rebuild the synced on-hand layers from the latest authoritative manual
 * snapshot. Dry-run by default; pass { apply: true } to write.
 *
 * @param {object} admin   service-role supabase client
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false]
 * @param {string[]} [opts.styleCodes]   restrict to these style_codes (rollout)
 * @param {string}  [opts.snapshotDate]  override the feed date (default: latest manual)
 * @param {string}  [opts.entityId]
 */
export async function rebuildOnHandSync(admin, opts = {}) {
  const apply = opts.apply === true;
  const entity_id = opts.entityId || (await resolveEntityId(admin));
  if (!entity_id) return { error: "could not resolve entity_id" };

  const date = opts.snapshotDate || (await latestManualDate(admin));
  if (!date) return { error: "no manual snapshot found" };

  // Feed = the authoritative on-hand at the latest manual date.
  let feedRows = await fetchAllPaged(
    admin,
    "ip_inventory_snapshot",
    "sku_id, warehouse_code, qty_on_hand",
    (q) => q.eq("source", "manual").eq("snapshot_date", date),
  );

  // Masters for the feed SKUs.
  const skuIds = [...new Set(feedRows.map((r) => r.sku_id).filter(Boolean))];
  const masterById = new Map();
  for (let i = 0; i < skuIds.length; i += 300) {
    const chunk = skuIds.slice(i, i + 300);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, style_id, sku_code, style_code")
      .in("id", chunk);
    if (error) return { error: `ip_item_master read failed: ${error.message}` };
    for (const m of data || []) masterById.set(m.id, m);
  }

  // Optional style-code scoping for staged rollout.
  if (Array.isArray(opts.styleCodes) && opts.styleCodes.length) {
    const want = new Set(opts.styleCodes.map((s) => String(s).toUpperCase()));
    feedRows = feedRows.filter((r) => {
      const m = masterById.get(r.sku_id);
      return m && want.has(String(m.style_code).toUpperCase());
    });
  }

  const feedStyleIds = [...new Set([...masterById.values()].map((m) => m.style_id).filter(Boolean))];
  const managedStyleIds = await computeManagedStyleIds(admin, entity_id, feedStyleIds);
  const avgCostCentsByCode = await fetchAvgCostByCode(admin, [...masterById.values()].map((m) => m.sku_code));

  const { data: locRows } = await admin.from("inventory_locations").select("id, code").eq("entity_id", entity_id);
  const locationIdByCode = new Map((locRows || []).map((l) => [l.code, l.id]));

  const plan = planOnHandSync({
    feedRows, masterById, managedStyleIds, avgCostCentsByCode, locationIdByCode, receivedAt: date,
  });

  const base = {
    snapshot_date: date,
    feed_styles: feedStyleIds.length,
    managed_styles: managedStyleIds.size,
    skipped_styles: feedStyleIds.length - managedStyleIds.size,
    ...plan.counts,
    touch_items: plan.touchItemIds.size,
  };

  if (!apply) return { dry_run: true, would_insert_layers: plan.insert.length, ...base };

  const touch = [...plan.touchItemIds];
  let seed_zeroed = 0, sync_deleted = 0, inserted = 0;

  // 1. Zero the legacy opening_balance seed on managed items (idempotent).
  for (let i = 0; i < touch.length; i += 200) {
    const chunk = touch.slice(i, i + 200);
    const { error, count } = await admin
      .from("inventory_layers")
      .update({ remaining_qty: 0 }, { count: "exact" })
      .eq("entity_id", entity_id)
      .eq("source_kind", SEED_KIND)
      .gt("remaining_qty", 0)
      .in("item_id", chunk);
    if (error) return { error: `seed zero failed: ${error.message}`, ...base };
    seed_zeroed += Number(count || 0);
  }

  // 2. Drop prior sync layers on managed items (drop-and-rebuild).
  for (let i = 0; i < touch.length; i += 200) {
    const chunk = touch.slice(i, i + 200);
    const { error, count } = await admin
      .from("inventory_layers")
      .delete({ count: "exact" })
      .eq("entity_id", entity_id)
      .eq("source_kind", SYNC_KIND)
      .in("item_id", chunk);
    if (error) return { error: `sync delete failed: ${error.message}`, ...base };
    sync_deleted += Number(count || 0);
  }

  // 3. Insert fresh sync layers.
  const rows = plan.insert.map((r) => ({ entity_id, ...r }));
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const { error } = await admin.from("inventory_layers").insert(chunk);
    if (error) return { error: `sync insert failed: ${error.message}`, inserted, ...base };
    inserted += chunk.length;
  }

  return { applied: true, seed_zeroed, sync_deleted, inserted, ...base };
}
