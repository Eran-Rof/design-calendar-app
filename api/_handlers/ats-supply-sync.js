// api/ats-supply-sync.js — Vercel Node.js Serverless Function
//
// Pulls supply state (on-hand, on-SO, on-PO from ATS upload) for the
// planning grid. Source: app_data['ats_excel_data'] which the ATS app
// already keeps fresh from manual uploads.
//
// Writes to ip_inventory_snapshot (one row per SKU per snapshot date).
// Uses today's date so successive runs roll forward.
//
// Performance: the auto-create-missing-items path used to run one
// upsert per SKU which timed out on multi-thousand catalogs. Now we
// bulk-upsert all missing items in 500-row chunks, then bulk-upsert
// all snapshot rows.

import { createClient } from "@supabase/supabase-js";
import { canonSku, canonStyleColor, buildItemRow } from "../_lib/sku-canon.js";

export const config = { maxDuration: 300 };
function toNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1. Pull the persisted ATS Excel snapshot.
  const { data: appRow, error: appErr } = await admin
    .from("app_data")
    .select("value")
    .eq("key", "ats_excel_data")
    .maybeSingle();
  if (appErr) return res.status(500).json({ error: "ats_excel_data fetch failed", details: appErr.message });
  if (!appRow?.value) return res.status(200).json({ error: "No ATS Excel snapshot uploaded yet — open ATS app and upload an inventory file first." });

  let parsed;
  try { parsed = typeof appRow.value === "string" ? JSON.parse(appRow.value) : appRow.value; }
  catch (e) { return res.status(500).json({ error: "ATS snapshot is not valid JSON", details: String(e) }); }

  const allSkus = Array.isArray(parsed?.skus) ? parsed.skus : [];
  if (allSkus.length === 0) return res.status(200).json({ error: "ATS snapshot has no SKU array", parsed_keys: Object.keys(parsed ?? {}) });

  // Chunked processing — large catalogs (10k+ SKUs) blow the Vercel
  // gateway timeout in a single call. Caller passes ?start=0 and the
  // handler returns next_start so the UI can keep clicking.
  const url = new URL(req.url, `https://${req.headers.host}`);
  const start = Math.max(parseInt(url.searchParams.get("start") || "0", 10), 0);
  const batchSize = Math.min(parseInt(url.searchParams.get("limit") || "2000", 10), 10000);
  const skus = allSkus.slice(start, start + batchSize);
  const nextStart = start + batchSize >= allSkus.length ? null : start + batchSize;

  const today = new Date().toISOString().slice(0, 10);
  const result = {
    ats_skus_total: allSkus.length,
    ats_skus_in_batch: skus.length,
    start, batch_size: batchSize,
    next_start: nextStart,
    done: nextStart === null,
    inserted: 0,
    auto_created_skus: 0,
    skipped_no_sku: 0,
    skipped_zero_state: 0,
    snapshot_date: today,
    errors: [],
  };

  // 2. Pre-canonicalize at style+color grain (drop size) and aggregate
  //    so multiple ATS rows for the same style+color (different sizes)
  //    sum into one snapshot row. Matches Excel-sourced grid SKUs.
  const aggMap = new Map();
  for (const s of skus) {
    const sku = canonStyleColor(s.sku);
    if (!sku) { result.skipped_no_sku++; continue; }
    const onHand = toNum(s.onHand);
    // ATS parser saves PO under `onOrder` (qty incoming from vendor)
    // and SO under `onCommitted` (qty committed to customer SOs).
    // The compute layer uses different names (onPO/onOrder/onSO), so
    // try all aliases to handle both raw-parser saves and compute saves.
    const onPO = toNum(s.onPO ?? s.onOrder);
    const onSo = toNum(s.onSO ?? s.onCommitted);
    if (onHand === 0 && onPO === 0 && onSo === 0) { result.skipped_zero_state++; continue; }
    const prev = aggMap.get(sku);
    if (!prev) {
      aggMap.set(sku, { sku, src: s, onHand, onPO, onSo });
    } else {
      prev.onHand += onHand;
      prev.onPO += onPO;
      prev.onSo += onSo;
      // Keep first src for description/cost — they should match across sizes anyway.
    }
  }
  const candidates = Array.from(aggMap.values());

  // 3. Resolve only the SKUs in this batch (instead of pulling the full
  //    20k-row item master). Postgres `in.` accepts long lists; chunk to
  //    stay under URL length limits.
  const itemMap = new Map();
  const candidateSkus = candidates.map((c) => c.sku);
  for (let i = 0; i < candidateSkus.length; i += 200) {
    const chunk = candidateSkus.slice(i, i + 200);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .in("sku_code", chunk);
    if (error) return res.status(500).json({ error: "item_master fetch failed", details: error.message });
    for (const r of data ?? []) itemMap.set(canonSku(r.sku_code), r.id);
  }

  // 4. Insert minimal stubs for any SKU not yet in master so its supply
  //    row has a sku_id to point at. NEVER write description / color /
  //    unit_cost — Item Master Excel is the SOLE source of those fields.
  //    Existing master rows are not touched (ON CONFLICT DO NOTHING).
  const preExistingSkus = new Set(itemMap.keys());
  const missingCandidates = candidates.filter((c) => !preExistingSkus.has(c.sku));
  if (missingCandidates.length > 0) {
    const newItems = missingCandidates.map((c) => buildItemRow(c.sku));
    for (let i = 0; i < newItems.length; i += 500) {
      const chunk = newItems.slice(i, i + 500);
      const { data: created, error } = await admin
        .from("ip_item_master")
        .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: true })
        .select("id, sku_code");
      if (error) {
        result.errors.push(`item bulk insert chunk ${i}: ${error.message}`);
        continue;
      }
      for (const row of created ?? []) itemMap.set(canonSku(row.sku_code), row.id);
    }
    const stillMissing = missingCandidates.filter((c) => !itemMap.has(c.sku)).map((c) => c.sku);
    if (stillMissing.length > 0) {
      for (let i = 0; i < stillMissing.length; i += 200) {
        const chunk = stillMissing.slice(i, i + 200);
        const { data } = await admin
          .from("ip_item_master")
          .select("id, sku_code")
          .in("sku_code", chunk);
        for (const r of data ?? []) itemMap.set(canonSku(r.sku_code), r.id);
      }
    }
    result.auto_created_skus = missingCandidates.length;
  }

  // 5. Build snapshot rows.
  const rows = [];
  for (const c of candidates) {
    const skuId = itemMap.get(c.sku);
    if (!skuId) { result.errors.push(`no id for ${c.sku} after stub insert`); continue; }
    rows.push({
      sku_id: skuId,
      warehouse_code: "DEFAULT",
      snapshot_date: today,
      qty_on_hand: c.onHand,
      qty_committed: c.onSo,
      qty_on_order: c.onPO,
      qty_available: Math.max(0, c.onHand - c.onSo),
      source: "manual",
    });
  }

  // 5b. Avg-cost rows: Item Master Excel is authoritative, do NOT write
  //     ip_item_avg_cost from ATS. The grid display layer falls back to
  //     PO unit cost when master has no cost — no need to mirror ATS cost.

  // 6. Bulk-upsert snapshot rows. Unique index =
  //    (sku_id, warehouse_code, snapshot_date, source).
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_inventory_snapshot")
      .upsert(chunk, { onConflict: "sku_id,warehouse_code,snapshot_date,source", ignoreDuplicates: false });
    if (error) result.errors.push(`snapshot chunk ${i}: ${error.message}`);
    else result.inserted += chunk.length;
  }

  // 7. Open SO line ingest — runs only on the first chunk (start=0). The
  //    parsed ATS Excel carries a `sos` array of one-row-per-SO-line
  //    objects with ship_date, qty, customer name, etc. We mirror that
  //    into ip_open_sales_orders so the planning grid's "On SO" column
  //    can finally bucket by ship date / customer.
  result.so_lines_total = 0;
  result.so_lines_inserted = 0;
  result.so_lines_pruned = 0;
  result.so_customers_created = 0;
  if (start === 0 && Array.isArray(parsed?.sos) && parsed.sos.length > 0) {
    const allSos = parsed.sos;
    result.so_lines_total = allSos.length;

    // 7a. Customer master lookup + auto-create for any unseen names.
    const customerByName = new Map();
    {
      const { data, error } = await admin
        .from("ip_customer_master")
        .select("id, customer_code, name");
      if (error) {
        result.errors.push(`so customer fetch failed: ${error.message}`);
      } else {
        for (const c of data ?? []) {
          const name = (c.name ?? "").trim().toUpperCase();
          if (name) customerByName.set(name, c.id);
        }
      }
    }
    // (Supply Only) placeholder — for SO lines without a customer name.
    let supplyOnlyId = null;
    {
      const SUPPLY_CODE = "INTERNAL:SUPPLY_ONLY";
      const { data: existing } = await admin
        .from("ip_customer_master")
        .select("id")
        .eq("customer_code", SUPPLY_CODE)
        .maybeSingle();
      if (existing?.id) {
        supplyOnlyId = existing.id;
      } else {
        const { data: created } = await admin
          .from("ip_customer_master")
          .upsert([{ customer_code: SUPPLY_CODE, name: "(Supply Only)" }], {
            onConflict: "customer_code", ignoreDuplicates: false,
          })
          .select("id")
          .maybeSingle();
        supplyOnlyId = created?.id ?? null;
      }
    }
    // Auto-create any SO customer name not in master so subsequent runs
    // resolve cleanly. Same code-pattern as xoro-sales-sync uses.
    const newCustomerNames = new Set();
    for (const so of allSos) {
      const raw = String(so.customerName ?? "").trim();
      if (!raw) continue;
      if (!customerByName.has(raw.toUpperCase())) newCustomerNames.add(raw);
    }
    if (newCustomerNames.size > 0) {
      const newRows = Array.from(newCustomerNames).map((name) => ({
        customer_code: `ATS:${name.toUpperCase().replace(/\s+/g, "")}`,
        name,
      }));
      for (let i = 0; i < newRows.length; i += 500) {
        const chunk = newRows.slice(i, i + 500);
        const { data, error } = await admin
          .from("ip_customer_master")
          .upsert(chunk, { onConflict: "customer_code", ignoreDuplicates: false })
          .select("id, name");
        if (error) {
          result.errors.push(`so customer create chunk ${i}: ${error.message}`);
          continue;
        }
        for (const c of data ?? []) {
          customerByName.set(String(c.name).toUpperCase(), c.id);
        }
        result.so_customers_created += chunk.length;
      }
    }

    // 7b. Build SO-row payloads. Resolve sku_id, customer_id; aggregate
    //     by (orderNumber, sku, ship_date) so multiple size lines for
    //     the same style+color collapse into one record.
    const soAgg = new Map();
    for (const so of allSos) {
      const sku = canonStyleColor(so.sku);
      if (!sku) continue;
      const skuId = itemMap.get(sku);
      if (!skuId) continue; // rare — only happens if the SKU isn't in the snapshot batch
      const shipDate = so.date ? String(so.date).slice(0, 10) : null;
      if (!shipDate) continue; // can't bucket undated SOs by period
      const custName = String(so.customerName ?? "").trim();
      const customerId = custName
        ? (customerByName.get(custName.toUpperCase()) ?? supplyOnlyId)
        : supplyOnlyId;
      const orderNumber = String(so.orderNumber ?? "").trim() || null;
      const lineKey = orderNumber
        ? `ats:${orderNumber}:${sku}:${shipDate}`
        : `ats:${customerId}:${sku}:${shipDate}`;
      const qty = Number(so.qty) || 0;
      const unitPrice = Number(so.unitPrice) || null;
      const prev = soAgg.get(lineKey);
      if (!prev) {
        soAgg.set(lineKey, {
          sku_id: skuId,
          customer_id: customerId,
          customer_name: custName || null,
          so_number: orderNumber,
          ship_date: shipDate,
          cancel_date: null,
          qty_ordered: qty,
          qty_shipped: 0,
          qty_open: qty,
          unit_price: unitPrice,
          currency: "USD",
          status: null,
          store: so.store ?? null,
          source: "ats",
          source_line_key: lineKey,
        });
      } else {
        // Weighted-avg unit price on qty_ordered.
        const total = prev.qty_ordered + qty;
        if (prev.unit_price != null && unitPrice != null && total > 0) {
          prev.unit_price = (prev.unit_price * prev.qty_ordered + unitPrice * qty) / total;
        } else if (unitPrice != null) {
          prev.unit_price = unitPrice;
        }
        prev.qty_ordered += qty;
        prev.qty_open += qty;
      }
    }

    // 7c. Capture sync timestamp so we can prune rows that weren't seen
    //     in this run. We explicitly set last_seen_at on every upsert
    //     row — the ip_set_updated_at trigger only bumps updated_at,
    //     and last_seen_at's DEFAULT only fires on INSERT, not UPDATE.
    const syncStartedAt = new Date().toISOString();
    const soRows = Array.from(soAgg.values()).map((r) => ({ ...r, last_seen_at: syncStartedAt }));
    for (let i = 0; i < soRows.length; i += 500) {
      const chunk = soRows.slice(i, i + 500);
      const { error } = await admin
        .from("ip_open_sales_orders")
        .upsert(chunk, { onConflict: "source,source_line_key", ignoreDuplicates: false });
      if (error) {
        result.errors.push(`so chunk ${i}: ${error.message}`);
        continue;
      }
      result.so_lines_inserted += chunk.length;
    }
    // 7d. Prune rows not seen in this run.
    if (result.so_lines_inserted > 0 && result.errors.length === 0) {
      const { count, error } = await admin
        .from("ip_open_sales_orders")
        .delete({ count: "exact" })
        .eq("source", "ats")
        .lt("last_seen_at", syncStartedAt);
      if (error) result.errors.push(`so prune failed: ${error.message}`);
      else result.so_lines_pruned = count ?? 0;
    }
  }

  return res.status(200).json(result);
}
