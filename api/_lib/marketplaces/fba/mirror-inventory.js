// api/_lib/marketplaces/fba/mirror-inventory.js
//
// Tangerine P12a-5 — FBA inventory mirror service.
//
// PURPOSE
// -------------------------------------------------------------------------
// For each active fba_seller_accounts row:
//   1. Decrypt LWA creds, refresh access_token, build SpApiClient.
//   2. Walk getInventorySummaries() paginated by nextToken.
//   3. Upsert one fba_inventory_snapshots row per (account, snapshot_at,
//      asin, sku) with the fulfillable / inbound / reserved /
//      unfulfillable quantity columns.
//   4. Rebuild inventory_layers for source_kind='fba_inbound' at the
//      account's fba_location_id — drop-and-rebuild pattern (T10-4):
//        DELETE WHERE source_kind='fba_inbound' AND location_id=<acct.fba_location_id>
//        INSERT one layer per non-zero fulfillable_qty with the resolved
//        ip_item_master_id and a per-SKU unit cost.
//   5. Stamp fba_seller_accounts.last_inventory_sync_at = now.
//
// SNAPSHOT_AT CONTRACT
// -------------------------------------------------------------------------
// All snapshots from a single cron run share the same snapshot_at = the
// run's started_at timestamp. This makes the UNIQUE
// (fba_seller_account_id, snapshot_at, asin, sku) clean across pages and
// keeps the "snapshot dot in time" semantics intact.
//
// LAYER REBUILD SCOPE
// -------------------------------------------------------------------------
// We only DELETE inventory_layers rows where
//   source_kind = 'fba_inbound' AND location_id = <acct.fba_location_id>
//
// This is critical: the layer table is shared across all source_kinds and
// all locations. Drop-and-rebuild ONLY touches the FBA-inbound rows at
// THIS account's location. Operator-typed adjustments and other FBA
// accounts' layers are left untouched.
//
// COST RESOLUTION
// -------------------------------------------------------------------------
// For each non-zero fulfillable_qty we need a unit_cost_cents to seed the
// rebuilt layer. Lookup order:
//   1. ip_item_master.standard_cost_cents for the SKU's item id.
//   2. Last AR-line unit cost (most recent fba_order_items row for the SKU).
//   3. Fallback = 0 cents (layer still inserted; operator will adjust).
//
// PER-ACCOUNT ERROR ISOLATION
// -------------------------------------------------------------------------
// One bad account never breaks the others. Each account's run is wrapped
// in try/catch; errors land in summary.accounts[*].error with ok:false.

import { decryptToken } from "./token-encryption.js";
import { refreshLwaAccessToken } from "./lwa.js";
import { SpApiClient } from "./client.js";

const MAX_PAGES_PER_ACCOUNT = 200; // 200 * 50 = 10000 SKUs/run/account cap
const LAYER_SOURCE_KIND = "fba_inbound";

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map a single SP-API inventorySummaries entry to the fba_inventory_snapshots
 * row shape. Quantity fields default to 0 when SP-API omits them.
 *
 * @param {Object} summary    raw SP-API InventorySummary
 * @param {string} fbaSellerAccountId
 * @param {string} snapshotAt ISO timestamp shared by the whole run
 * @returns {Object}          fba_inventory_snapshots insert payload
 */
export function mapSnapshotRow(summary, fbaSellerAccountId, snapshotAt) {
  const det = summary.inventoryDetails || {};
  const inbound = det.inboundShipmentQuantities || det.inboundQuantities || {};
  return {
    fba_seller_account_id: fbaSellerAccountId,
    snapshot_at: snapshotAt,
    asin: summary.asin || null,
    sku: summary.sellerSku || null,
    fulfillable_qty: Number(det.fulfillableQuantity ?? summary.totalQuantity ?? 0) || 0,
    inbound_working_qty: Number(inbound.inboundWorkingQuantity ?? 0) || 0,
    inbound_shipped_qty: Number(inbound.inboundShippedQuantity ?? 0) || 0,
    inbound_receiving_qty: Number(inbound.inboundReceivingQuantity ?? 0) || 0,
    reserved_qty: Number(det.reservedQuantity?.totalReservedQuantity ?? det.reservedQuantity ?? 0) || 0,
    unfulfillable_qty: Number(det.unfulfillableQuantity?.totalUnfulfillableQuantity ?? det.unfulfillableQuantity ?? 0) || 0,
    raw_payload: summary,
  };
}

/**
 * Decrypt the encrypted LWA credentials triple from a fba_seller_accounts
 * row. Mirrors the helper in ingest-orders.js (kept local so the inventory
 * service can be imported without dragging in the orders ingest module).
 *
 * @param {Object} acct  row from fba_seller_accounts
 * @returns {{clientId: string, clientSecret: string, refreshToken: string}}
 */
export function decryptAccountCreds(acct) {
  if (!acct.lwa_client_id_ciphertext || !acct.lwa_client_id_iv || !acct.lwa_client_id_tag) {
    throw new Error("account missing encrypted lwa_client_id triple");
  }
  if (!acct.lwa_client_secret_ciphertext || !acct.lwa_client_secret_iv || !acct.lwa_client_secret_tag) {
    throw new Error("account missing encrypted lwa_client_secret triple");
  }
  if (!acct.refresh_token_ciphertext || !acct.refresh_token_iv || !acct.refresh_token_tag) {
    throw new Error("account missing encrypted refresh_token triple");
  }
  const clientId = decryptToken(
    acct.lwa_client_id_ciphertext, acct.lwa_client_id_iv, acct.lwa_client_id_tag,
  );
  const clientSecret = decryptToken(
    acct.lwa_client_secret_ciphertext, acct.lwa_client_secret_iv, acct.lwa_client_secret_tag,
  );
  const refreshToken = decryptToken(
    acct.refresh_token_ciphertext, acct.refresh_token_iv, acct.refresh_token_tag,
  );
  return { clientId, clientSecret, refreshToken };
}

/**
 * Resolve ip_item_master.id + standard_cost_cents for a batch of SKUs.
 * Returns a Map keyed by sku → { id, unit_cost_cents }.
 *
 * Tolerant of missing standard_cost_cents column; failures collapse to a
 * null-cost entry (cost defaults to 0n at insert).
 *
 * @param {Object} adminClient
 * @param {string} entityId
 * @param {string[]} skus
 * @returns {Promise<Map<string, {id: string, unit_cost_cents: number}>>}
 */
export async function resolveItemMastersBySku(adminClient, entityId, skus) {
  const out = new Map();
  const clean = (skus || []).filter((s) => typeof s === "string" && s.length > 0);
  if (clean.length === 0) return out;
  const { data, error } = await adminClient
    .from("ip_item_master")
    .select("id, sku_code, standard_cost_cents")
    .eq("entity_id", entityId)
    .in("sku_code", clean);
  if (error) {
    // Schema variant — retry without the cost column.
    const { data: data2, error: error2 } = await adminClient
      .from("ip_item_master")
      .select("id, sku_code")
      .eq("entity_id", entityId)
      .in("sku_code", clean);
    if (error2) {
      throw new Error(`ip_item_master lookup failed: ${error.message}`);
    }
    for (const row of data2 || []) {
      if (row.sku_code) out.set(row.sku_code, { id: row.id, unit_cost_cents: 0 });
    }
    return out;
  }
  for (const row of (data || [])) {
    if (row.sku_code) {
      out.set(row.sku_code, {
        id: row.id,
        unit_cost_cents: Number(row.standard_cost_cents) || 0,
      });
    }
  }
  return out;
}

/**
 * For SKUs missing a standard_cost_cents, fall back to the last AR-line
 * unit cost from fba_order_items. Returns a Map sku → unit_cost_cents.
 *
 * Looks at the most recent fba_order_items row per sku where
 * item_price_cents > 0. Used as a best-effort fallback; missing SKUs
 * stay missing (caller falls back to 0).
 */
export async function resolveLastArCostBySku(adminClient, fbaSellerAccountId, skus) {
  const out = new Map();
  const clean = (skus || []).filter((s) => typeof s === "string" && s.length > 0);
  if (clean.length === 0) return out;
  // Pull recent items for this account; cap at 1000 to keep the query bounded.
  const { data, error } = await adminClient
    .from("fba_order_items")
    .select("sku, item_price_cents, quantity_ordered, fba_order:fba_order_id(fba_seller_account_id)")
    .in("sku", clean)
    .gt("item_price_cents", 0)
    .order("id", { ascending: false })
    .limit(1000);
  if (error) {
    // Best-effort fallback. Return empty Map so caller falls back to 0.
    return out;
  }
  for (const row of (data || [])) {
    if (!row.sku || out.has(row.sku)) continue;
    // If the FK join is present, scope to this account.
    if (row.fba_order && row.fba_order.fba_seller_account_id && row.fba_order.fba_seller_account_id !== fbaSellerAccountId) {
      continue;
    }
    const qty = Number(row.quantity_ordered) || 1;
    const unit = qty > 0 ? Math.round(Number(row.item_price_cents) / qty) : Number(row.item_price_cents);
    if (Number.isFinite(unit) && unit > 0) out.set(row.sku, unit);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-account sync
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mirror inventory for a single fba_seller_accounts row.
 *
 * @param {Object} supabase  service-role client
 * @param {Object} acct      fba_seller_accounts row
 * @param {Object} [opts]
 * @param {Date}     [opts.now]
 * @param {Object}   [opts.deps]
 * @param {Function} [opts.deps.refreshAccessToken]
 * @param {Function} [opts.deps.makeClient]
 * @returns {Promise<Object>}
 */
export async function mirrorAccountInventory(supabase, acct, opts = {}) {
  const now = opts.now || new Date();
  const snapshotAt = now.toISOString();
  const summary = {
    fba_seller_account_id: acct.id,
    snapshot_at: snapshotAt,
    snapshots_upserted: 0,
    layers_inserted: 0,
    layers_deleted: 0,
    pages: 0,
    error: null,
  };

  const refreshAccessToken = opts.deps?.refreshAccessToken || refreshLwaAccessToken;
  const makeClient = opts.deps?.makeClient || ((clientArgs) => new SpApiClient(clientArgs));

  const creds = decryptAccountCreds(acct);
  const tokenResp = await refreshAccessToken({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken,
  });

  const client = makeClient({
    region: acct.region,
    accessToken: tokenResp.access_token,
    marketplaceId: acct.marketplace_id,
    awsRoleArn: acct.aws_role_arn || null,
  });

  // ── 1. Walk getInventorySummaries paginated by nextToken ─────────────
  const allSummaries = [];
  let nextToken = null;
  let firstPage = true;
  for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
    const resp = firstPage
      ? await client.getInventorySummaries({ marketplaceId: acct.marketplace_id })
      : await client.getInventorySummaries({ marketplaceId: acct.marketplace_id, nextToken });
    firstPage = false;
    summary.pages++;
    const list = resp.inventorySummaries || [];
    for (const s of list) allSummaries.push(s);
    nextToken = (resp.pagination && resp.pagination.nextToken) || null;
    if (!nextToken) break;
  }

  // ── 2. Upsert fba_inventory_snapshots ─────────────────────────────────
  for (const s of allSummaries) {
    const row = mapSnapshotRow(s, acct.id, snapshotAt);
    const { error: upErr } = await supabase
      .from("fba_inventory_snapshots")
      .upsert(row, { onConflict: "fba_seller_account_id,snapshot_at,asin,sku" });
    if (upErr) {
      throw new Error(`fba_inventory_snapshots upsert failed for ${row.sku || row.asin}: ${upErr.message}`);
    }
    summary.snapshots_upserted++;
  }

  // ── 3. Rebuild inventory_layers for source_kind='fba_inbound' at this
  //       account's location. Only proceed if the account has a
  //       fba_location_id configured.
  if (acct.fba_location_id) {
    // 3a. DELETE existing fba_inbound layers at THIS location only.
    const { data: deleted, error: delErr } = await supabase
      .from("inventory_layers")
      .delete()
      .eq("source_kind", LAYER_SOURCE_KIND)
      .eq("location_id", acct.fba_location_id)
      .select("id");
    if (delErr) {
      throw new Error(`inventory_layers fba_inbound delete failed: ${delErr.message}`);
    }
    summary.layers_deleted = (deleted || []).length;

    // 3b. Resolve ip_item_master_id + cost for each non-zero SKU.
    const nonZero = allSummaries.filter((s) => {
      const det = s.inventoryDetails || {};
      const q = Number(det.fulfillableQuantity ?? s.totalQuantity ?? 0) || 0;
      return q > 0 && typeof s.sellerSku === "string" && s.sellerSku.length > 0;
    });
    const skus = Array.from(new Set(nonZero.map((s) => s.sellerSku)));

    const masters = await resolveItemMastersBySku(supabase, acct.entity_id, skus);
    // For SKUs that resolved to an item but have cost=0, try the AR-line
    // fallback. Skip when we have no masters at all (saves a round-trip).
    let arCosts = new Map();
    if (masters.size > 0) {
      const needCost = [];
      for (const sku of skus) {
        const m = masters.get(sku);
        if (m && (!m.unit_cost_cents || m.unit_cost_cents === 0)) needCost.push(sku);
      }
      if (needCost.length > 0) {
        arCosts = await resolveLastArCostBySku(supabase, acct.id, needCost);
      }
    }

    // 3c. INSERT one layer per non-zero SKU that resolved to an item.
    const layerRows = [];
    for (const s of nonZero) {
      const sku = s.sellerSku;
      const master = masters.get(sku);
      if (!master) continue; // can't insert a layer without item_id
      const det = s.inventoryDetails || {};
      const qty = Number(det.fulfillableQuantity ?? s.totalQuantity ?? 0) || 0;
      const unitCost = master.unit_cost_cents > 0
        ? master.unit_cost_cents
        : (arCosts.get(sku) || 0);
      layerRows.push({
        entity_id: acct.entity_id,
        item_id: master.id,
        location_id: acct.fba_location_id,
        received_at: snapshotAt,
        original_qty: qty,
        remaining_qty: qty,
        unit_cost_cents: unitCost,
        source_kind: LAYER_SOURCE_KIND,
        notes: `FBA mirror snapshot ${snapshotAt} (account=${acct.id})`,
      });
    }

    if (layerRows.length > 0) {
      const { error: insErr } = await supabase
        .from("inventory_layers")
        .insert(layerRows);
      if (insErr) {
        throw new Error(`inventory_layers fba_inbound insert failed: ${insErr.message}`);
      }
      summary.layers_inserted = layerRows.length;
    }
  }

  // ── 4. Stamp last_inventory_sync_at ───────────────────────────────────
  const { error: updErr } = await supabase
    .from("fba_seller_accounts")
    .update({ last_inventory_sync_at: snapshotAt, updated_at: snapshotAt })
    .eq("id", acct.id);
  if (updErr) {
    throw new Error(`last_inventory_sync_at update failed: ${updErr.message}`);
  }

  return summary;
}

// ──────────────────────────────────────────────────────────────────────────
// Multi-account driver
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mirror inventory for every active fba_seller_accounts row. Per-account
 * try/catch — one failing account never breaks the others.
 *
 * @param {Object} args
 * @param {Object} args.adminClient   Supabase service-role client
 * @param {Object} [args.opts]        forwarded to mirrorAccountInventory
 * @returns {Promise<{accounts: Object[], started_at: string, finished_at: string}>}
 */
export async function mirrorFbaInventory({ adminClient, opts } = {}) {
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("mirrorFbaInventory: adminClient required");
  }
  const started_at = new Date().toISOString();
  const { data: accounts, error } = await adminClient
    .from("fba_seller_accounts")
    .select("*")
    .eq("is_active", true);
  if (error) throw new Error(`fba_seller_accounts read failed: ${error.message}`);

  const results = [];
  for (const acct of (accounts || [])) {
    try {
      const r = await mirrorAccountInventory(adminClient, acct, opts || {});
      results.push({ ok: true, ...r });
    } catch (e) {
      results.push({
        ok: false,
        fba_seller_account_id: acct.id,
        snapshot_at: null,
        snapshots_upserted: 0,
        layers_inserted: 0,
        layers_deleted: 0,
        pages: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    started_at,
    finished_at: new Date().toISOString(),
    accounts: results,
  };
}
