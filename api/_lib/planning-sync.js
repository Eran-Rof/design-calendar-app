// api/_lib/planning-sync.js
//
// Shared core for the two planning supply syncs. Lifted out of the
// individual route handlers so the chunked UI button (existing
// /api/ats-supply-sync, /api/tanda-pos-sync) and the
// scriptable endpoints (/api/planning/sync-on-hand,
// /api/planning/sync-open-pos) can call the same code path.
//
// Each function accepts a Supabase admin client + structured options
// and returns a plain result object. Callers handle HTTP plumbing
// (CORS, auth, response shape mapping). DO NOT add res/req-shaped
// arguments here — keep this file framework-agnostic so it stays
// unit-testable.

import { canonSku, canonStyleColor, buildItemRow } from "./sku-canon.js";
import { unpackGzipEnvelope } from "./gzipEnvelope.js";

function toNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// Look up a sku_id in the item-master map, falling back to a
// PPK-suffix-stripped form when the direct match misses. ATS / Xoro
// sometimes report prepack SKUs with the size token baked in
// ("RYG1842PPK-BLACK-PPK24") while master stores the bare
// (style, color) form ("RYG1842PPK-BLACK"). Without this strip
// fallback, prepack SOs / on-hand / receipt rows silently fail to
// resolve and either get dropped (SOs) or produce ugly auto-created
// master rows (on-hand). Mirrors the alias logic in
// src/ats/itemMasterLookup.ts.
function lookupSkuIdWithPpkFallback(itemMap, canonical) {
  const direct = itemMap.get(canonical);
  if (direct) return direct;
  const stripped = canonical.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, "");
  if (stripped !== canonical) return itemMap.get(stripped);
  return undefined;
}

// Look up a size-grain master row for a color-grain candidate. The
// planning sync aggregates inventory + SOs + POs at (style, color)
// grain (canonStyleColor strips the size token), but post_master_data
// loads ip_item_master at (style, color, size) grain from the
// CurrentProducts export. So a candidate like "RYB1469OB-BLACK" misses
// lookups against master rows like "RYB1469OB-Black-SML" / "-MED" /
// "-LRG" / "-XLG". The pre-existing PPK-strip fallback handles only
// "-PPKn" suffixes; regular size suffixes need a wildcard lookup.
//
// Without this fallback the code falls through to buildItemRow, which
// writes a minimal stub that violates ip_item_master's
// apparel_dims_required CHECK — silently dropping every new BOTTOMS
// PO (and any new style without a same-color master row yet) from
// Inventory Planning every nightly. The 2026-05-29 manual rerun
// dropped ~15k incoming PO units across 6 styles via this path.
//
// Cost: one PostgREST round-trip per still-missing SKU. Per-nightly
// missing set is typically <20 so this is cheap relative to the
// signal recovery. Batch via .or() chain if it routinely exceeds ~50.
async function resolveSizeGrainFallback(admin, missingSkus, itemMap) {
  if (!missingSkus || missingSkus.length === 0) return;
  for (const sku of missingSkus) {
    if (itemMap.has(sku)) continue;
    // Defensive escape of ilike wildcards (% / _ / \) so a SKU
    // containing one doesn't widen the match. Real SKUs shouldn't
    // contain these but the cost of being safe is zero.
    const safe = sku.replace(/[\\%_]/g, (m) => `\\${m}`);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .ilike("sku_code", `${safe}-%`)
      .limit(1);
    if (error || !data || !data[0]) continue;
    itemMap.set(sku, data[0].id);
  }
}

function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Build a map of PO number → expected DDP arrival date from Tanda milestones.
// The "In House / DDP" milestone (days_before_ddp = 0) is the ops-maintained
// expected arrival; we prefer its actual_date once set, else its expected_date.
// When a PO carries several DDP rows (variant milestones) take the LATEST date
// (so we never project an arrival earlier than the ops team expects).
//
// M31 / P17 WIP-timing refinement: "inbound PO is WIP" — the open-PO qty is the
// in-production supply, so rather than add a (double-counting) separate WIP
// bucket, we use the milestone DDP to land that inbound PO in the correct
// planning month. Pure (IO is in syncOpenPosFromTandaPos) so it's unit-testable.
export function buildDdpDateMap(milestoneRows) {
  const map = new Map();
  for (const r of milestoneRows || []) {
    const d = r && r.data;
    if (!d) continue;
    if (Number(d.days_before_ddp) !== 0) continue;
    const poNum = String(d.po_number || "").trim();
    if (!poNum) continue;
    const date = toIsoDate(d.actual_date || d.expected_date);
    if (!date) continue;
    const prev = map.get(poNum);
    if (!prev || date > prev) map.set(poNum, date);
  }
  return map;
}

// ── On-hand from ATS Excel snapshot ──────────────────────────────────────────
//
// One chunk of the supply sync. Returns next_start so callers can
// page through multi-thousand SKU catalogs without exceeding the 60s
// gateway. The new POST /api/planning/sync-on-hand endpoint loops
// internally until done; the legacy chunked endpoint forwards
// next_start to the browser instead.
//
// Side effects (in order, all transactional within Supabase):
//   1. Upsert ip_item_master stubs for any SKU not already present
//   2. Bulk-upsert ip_inventory_snapshot rows dated to the feed's latest
//      "Last Receipt Date" (a Xoro date), not the import day
//   3. On the first chunk only: rebuild ip_open_sales_orders from the
//      `sos` array in the ATS snapshot, pruning lines no longer present
export async function syncOnHandChunkFromAtsSnapshot(admin, { start = 0, limit = 2000 } = {}) {
  const result = {
    ats_skus_total: 0,
    ats_skus_in_batch: 0,
    start, batch_size: limit,
    next_start: null,
    done: true,
    inserted: 0,
    auto_created_skus: 0,
    skipped_no_sku: 0,
    skipped_zero_state: 0,
    snapshot_date: new Date().toISOString().slice(0, 10),
    so_lines_total: 0,
    so_lines_inserted: 0,
    so_lines_pruned: 0,
    so_customers_created: 0,
    so_skus_auto_created: 0,
    so_skipped_no_sku: 0,
    so_skipped_no_sku_id: 0,
    errors: [],
  };

  const { data: appRow, error: appErr } = await admin
    .from("app_data")
    .select("value")
    .eq("key", "ats_excel_data")
    .maybeSingle();
  if (appErr) {
    return { ...result, error: "ats_excel_data fetch failed", details: appErr.message };
  }
  if (!appRow?.value) {
    return { ...result, error: "No ATS Excel snapshot uploaded yet — upload via /api/ats/upload first." };
  }

  // ATS now writes ats_excel_data as a gzip+base64 envelope to keep
  // large uploads under Supabase's 8s statement timeout. The unpacker
  // detects the envelope and falls back to plain JSON for legacy
  // uncompressed rows still in app_data.
  let parsed;
  try {
    parsed = unpackGzipEnvelope(appRow.value);
  } catch (e) {
    return { ...result, error: "ATS snapshot decode failed", details: String(e) };
  }
  if (parsed == null) {
    return { ...result, error: "ATS snapshot is not valid JSON" };
  }

  const allSkus = Array.isArray(parsed?.skus) ? parsed.skus : [];
  result.ats_skus_total = allSkus.length;
  if (allSkus.length === 0) {
    return { ...result, error: "ATS snapshot has no SKU array", parsed_keys: Object.keys(parsed ?? {}) };
  }

  // Xoro-date policy: the ATS on-hand snapshot's as-of date is the LATEST
  // "Last Receipt Date" reported in the feed (a Xoro-derived date), NOT the
  // import day. Computed over the FULL feed so every chunk agrees on one
  // snapshot_date — it's part of the ip_inventory_snapshot upsert key, so a
  // per-chunk date would fragment the snapshot. `lastReceiptDate` is stored ISO
  // (YYYY-MM-DD) by the ATS parser; guard on that shape. Falls back to today
  // only if no row carries a parseable receipt date.
  //
  // ⚠️ CLAMP AT TODAY: a "Last Receipt Date" in the future is a future INCOMING
  // PO/receipt, not a real receipt of on-hand you already have. Without the
  // clamp, one future-dated line pushed the whole snapshot's as-of date months
  // ahead (e.g. 2026-12-06), and since planning reads the LATEST snapshot per
  // SKU, that future-dated snapshot won and skewed on-hand. Never date an
  // on-hand snapshot past today.
  {
    const today = new Date().toISOString().slice(0, 10);
    let maxReceipt = "";
    for (const s of allSkus) {
      const d = typeof s?.lastReceiptDate === "string" ? s.lastReceiptDate.trim() : "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today && d > maxReceipt) maxReceipt = d;
    }
    if (maxReceipt) result.snapshot_date = maxReceipt;
  }

  const skus = allSkus.slice(start, start + limit);
  result.ats_skus_in_batch = skus.length;
  const nextStart = start + limit >= allSkus.length ? null : start + limit;
  result.next_start = nextStart;
  result.done = nextStart === null;

  // Aggregate at style+color grain so multi-size lines collapse.
  const aggMap = new Map();
  for (const s of skus) {
    const sku = canonStyleColor(s.sku);
    if (!sku) { result.skipped_no_sku++; continue; }
    const onHand = toNum(s.onHand);
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
    }
  }
  const candidates = Array.from(aggMap.values());

  // Resolve only the SKUs in this batch — chunked to stay under URL limits.
  // Also pre-fetch any candidates whose canonical sku looks like
  // "STYLE-COLOR-PPKn" by stripping the suffix and looking up the
  // bare (style, color) form too. Stops ATS prepack inventory from
  // auto-creating shadow master rows when the real prepack row
  // already exists at the canonical key.
  const itemMap = new Map();
  const candidateSkus = candidates.map((c) => c.sku);
  const ppkStrippedExtras = Array.from(new Set(
    candidates
      .map((c) => c.sku.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, ""))
      .filter((stripped, i) => stripped && stripped !== candidates[i].sku),
  ));
  const allLookupSkus = [...candidateSkus, ...ppkStrippedExtras];
  for (let i = 0; i < allLookupSkus.length; i += 200) {
    const chunk = allLookupSkus.slice(i, i + 200);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .in("sku_code", chunk);
    if (error) return { ...result, error: "item_master fetch failed", details: error.message };
    for (const r of data ?? []) itemMap.set(canonSku(r.sku_code), r.id);
  }

  // Stub-create any SKU not in master. NEVER write description / cost — the
  // Item Master Excel is the SOLE source of those fields. Resolve via
  // the PPK-strip fallback first so a prepack inventory row whose SKU
  // includes "-PPKn" reuses the existing bare (style, color) master
  // row instead of creating a new shadow row.
  for (const c of candidates) {
    if (itemMap.has(c.sku)) continue;
    const stripped = c.sku.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, "");
    if (stripped !== c.sku && itemMap.has(stripped)) {
      itemMap.set(c.sku, itemMap.get(stripped));
    }
  }
  // Size-grain DB fallback for any color-grain candidate whose PPK
  // strip didn't resolve. See resolveSizeGrainFallback for rationale.
  await resolveSizeGrainFallback(
    admin,
    candidates.filter((c) => !itemMap.has(c.sku)).map((c) => c.sku),
    itemMap,
  );
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

  // Build snapshot rows. snapshot_date = the feed's latest Last Receipt Date
  // (set above), not the import day.
  const snapshotDate = result.snapshot_date;
  const rows = [];
  for (const c of candidates) {
    const skuId = itemMap.get(c.sku);
    if (!skuId) { result.errors.push(`no id for ${c.sku} after stub insert`); continue; }
    rows.push({
      sku_id: skuId,
      warehouse_code: "DEFAULT",
      snapshot_date: snapshotDate,
      qty_on_hand: c.onHand,
      qty_committed: c.onSo,
      qty_on_order: c.onPO,
      qty_available: Math.max(0, c.onHand - c.onSo),
      source: "manual",
    });
  }

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_inventory_snapshot")
      .upsert(chunk, { onConflict: "sku_id,warehouse_code,snapshot_date,source", ignoreDuplicates: false });
    if (error) result.errors.push(`snapshot chunk ${i}: ${error.message}`);
    else result.inserted += chunk.length;
  }

  // Open-SO ingest only on the first chunk so we don't reset progress
  // mid-walk.
  if (start === 0 && Array.isArray(parsed?.sos) && parsed.sos.length > 0) {
    const allSos = parsed.sos;
    result.so_lines_total = allSos.length;

    const customerByName = new Map();
    {
      const { data, error } = await admin
        .from("ip_customer_master")
        .select("id, customer_code, name");
      if (error) {
        result.errors.push(`so customer fetch failed: ${error.message}`);
        return result;
      }
      for (const c of data ?? []) {
        const name = (c.name ?? "").trim().toUpperCase();
        if (name) customerByName.set(name, c.id);
      }
    }

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

    // Expand itemMap to cover SO SKUs that aren't in this chunk's
    // inventory itemMap. Inventory itemMap was built from this chunk's
    // ~2000 SKUs only — SOs reference the FULL SKU set across all
    // chunks, plus any SKU with SO activity but no inventory presence.
    // Without this, SOs for chunk-2+ SKUs (or zero-inventory active
    // SKUs) get silently dropped at the if (!skuId) continue below
    // — which lost ~$5M of the $9.4M SO book in production
    // (discovered 2026-05-13 — user reported $4M instead of expected
    // $9M after running the nightly).
    //
    // Step 1: bulk-lookup any SO SKU not already in itemMap.
    // Step 2: stub-create the still-missing ones in ip_item_master,
    // mirroring the inventory side's behaviour.
    {
      const soSkuSet = new Set();
      for (const so of allSos) {
        const sku = canonStyleColor(so.sku);
        if (!sku) continue;
        if (!itemMap.has(sku)) soSkuSet.add(sku);
      }
      // Also include PPK-stripped variants so a prepack SO whose SKU
      // bakes the size token in resolves to the bare (style, color)
      // master row. Mirrors the inventory-side fallback above.
      const ppkStrippedSoExtras = new Set();
      for (const sku of soSkuSet) {
        const stripped = sku.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, "");
        if (stripped !== sku && !itemMap.has(stripped)) ppkStrippedSoExtras.add(stripped);
      }
      const allSoLookupSkus = [...soSkuSet, ...ppkStrippedSoExtras];
      for (let i = 0; i < allSoLookupSkus.length; i += 200) {
        const chunk = allSoLookupSkus.slice(i, i + 200);
        const { data, error } = await admin
          .from("ip_item_master")
          .select("id, sku_code")
          .in("sku_code", chunk);
        if (error) {
          result.errors.push(`so item_master fetch: ${error.message}`);
          continue;
        }
        for (const r of data ?? []) itemMap.set(canonSku(r.sku_code), r.id);
      }
      // Stub-create still-missing SO SKUs so the SO line gets persisted
      // instead of silently dropped. Same minimal-payload rule as
      // inventory stubs (sku_code + parsed style_code + active=true).
      const stillMissingSoSkus = [];
      for (const sku of soSkuSet) {
        if (itemMap.has(sku)) continue;
        const stripped = sku.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, "");
        if (stripped !== sku && itemMap.has(stripped)) {
          itemMap.set(sku, itemMap.get(stripped));
          continue;
        }
        stillMissingSoSkus.push(sku);
      }
      // Size-grain DB fallback. Drop SKUs it resolves so the
      // stub-create loop below doesn't double-write them.
      await resolveSizeGrainFallback(admin, [...stillMissingSoSkus], itemMap);
      for (let i = stillMissingSoSkus.length - 1; i >= 0; i--) {
        if (itemMap.has(stillMissingSoSkus[i])) stillMissingSoSkus.splice(i, 1);
      }
      if (stillMissingSoSkus.length > 0) {
        const newItems = stillMissingSoSkus.map((sku) => buildItemRow(sku));
        for (let i = 0; i < newItems.length; i += 500) {
          const chunk = newItems.slice(i, i + 500);
          const { data: created, error } = await admin
            .from("ip_item_master")
            .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: true })
            .select("id, sku_code");
          if (error) {
            result.errors.push(`so item bulk insert chunk ${i}: ${error.message}`);
            continue;
          }
          for (const row of created ?? []) itemMap.set(canonSku(row.sku_code), row.id);
        }
        result.so_skus_auto_created = (result.so_skus_auto_created ?? 0) + stillMissingSoSkus.length;
      }
    }

    const soAgg = new Map();
    for (const so of allSos) {
      const sku = canonStyleColor(so.sku);
      if (!sku) {
        result.so_skipped_no_sku = (result.so_skipped_no_sku ?? 0) + 1;
        continue;
      }
      const skuId = lookupSkuIdWithPpkFallback(itemMap, sku);
      if (!skuId) {
        // Should be rare now after the expand+stub above. Surfaced as
        // a counter so a future regression (e.g. a Xoro change in SKU
        // shape that breaks canonStyleColor) is visible immediately
        // in the response instead of as silent $ shrinkage.
        result.so_skipped_no_sku_id = (result.so_skipped_no_sku_id ?? 0) + 1;
        continue;
      }
      // Persist undated SOs with ship_date=null instead of dropping
      // them. Reason: ATS exports often contain backorders / suspended
      // orders / freshly-created lines without a scheduled ship date.
      // Dropping them at sync time meant the planning grid's SO column
      // was zero everywhere — the bug Eran reported. The bucketing
      // step in wholesaleForecastService still excludes undated SOs
      // from per-period display (correct — they can't be bucketed),
      // but the qty is now captured in the DB so a future "undated
      // SO total" banner can surface them.
      const shipDate = so.date ? String(so.date).slice(0, 10) : null;
      const custName = String(so.customerName ?? "").trim();
      const customerId = custName
        ? (customerByName.get(custName.toUpperCase()) ?? supplyOnlyId)
        : supplyOnlyId;
      const orderNumber = String(so.orderNumber ?? "").trim() || null;
      // Use "no-date" as the dedup suffix when shipDate is null so two
      // different SOs for the same (order, sku) don't collapse just
      // because both lack a date.
      const dateKey = shipDate ?? "no-date";
      const lineKey = orderNumber
        ? `ats:${orderNumber}:${sku}:${dateKey}`
        : `ats:${customerId}:${sku}:${dateKey}`;
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

  return result;
}

// Run the chunked sync end-to-end. Used by the new
// /api/planning/sync-on-hand endpoint and any caller that wants the
// whole catalog synced in one call without managing pagination.
export async function syncOnHandFromAtsSnapshot(admin, { chunkSize = 2000 } = {}) {
  let start = 0;
  let chunks = 0;
  let upserted = 0;
  let newSkus = 0;
  let skipped = 0;
  let scanned = 0;
  // SO ingest only fires on chunk 1, but we track these so the response
  // surfaces them. Without them, a future regression in SO promote (e.g.
  // the "$4M instead of $9M" bug 2026-05-13) would not be visible until
  // someone manually compares ATS UI vs DB totals.
  let soTotal = 0;
  let soInserted = 0;
  let soPruned = 0;
  let soSkusAutoCreated = 0;
  let soSkippedNoSku = 0;
  let soSkippedNoSkuId = 0;
  let soCustomersCreated = 0;
  const errors = [];
  let firstError = null;

  while (true) {
    const r = await syncOnHandChunkFromAtsSnapshot(admin, { start, limit: chunkSize });
    chunks++;
    if (r.error && !firstError) firstError = { error: r.error, details: r.details ?? null };
    upserted += r.inserted ?? 0;
    newSkus += r.auto_created_skus ?? 0;
    skipped += (r.skipped_zero_state ?? 0) + (r.skipped_no_sku ?? 0);
    scanned = r.ats_skus_total ?? scanned;
    soTotal += r.so_lines_total ?? 0;
    soInserted += r.so_lines_inserted ?? 0;
    soPruned += r.so_lines_pruned ?? 0;
    soSkusAutoCreated += r.so_skus_auto_created ?? 0;
    soSkippedNoSku += r.so_skipped_no_sku ?? 0;
    soSkippedNoSkuId += r.so_skipped_no_sku_id ?? 0;
    soCustomersCreated += r.so_customers_created ?? 0;
    if (Array.isArray(r.errors) && r.errors.length > 0) errors.push(...r.errors);
    if (firstError) break;
    if (r.done || r.next_start == null) break;
    start = r.next_start;
  }

  return {
    upserted,
    new_skus: newSkus,
    skipped,
    scanned,
    chunks,
    so_lines_total: soTotal,
    so_lines_inserted: soInserted,
    so_lines_pruned: soPruned,
    so_skus_auto_created: soSkusAutoCreated,
    so_skipped_no_sku: soSkippedNoSku,
    so_skipped_no_sku_id: soSkippedNoSkuId,
    so_customers_created: soCustomersCreated,
    errors,
    error: firstError?.error ?? null,
    details: firstError?.details ?? null,
  };
}

// ── Open POs from PO WIP (tanda_pos) ─────────────────────────────────────────
//
// Pulls every non-archived PO row from the tanda_pos table, flattens to
// line items at the style+color grain, resolves each SKU to its
// ip_item_master id (auto-creating stubs as needed) and upserts
// ip_open_purchase_orders. Stale rows (POs that closed since the last
// sync) are deleted at the end so the planning grid never shows
// already-received supply.
export async function syncOpenPosFromTandaPos(admin) {
  const result = {
    pos_scanned: 0,
    inserted: 0,
    auto_created_skus: 0,
    skipped_archived: 0,
    skipped_no_lines: 0,
    skipped_no_sku: 0,
    skipped_zero_open: 0,
    skipped_eom: 0,
    cleaned: 0,
    expected_date_from_milestone: 0,
    errors: [],
  };
  // Stamp on every upserted row so v_xoro_feed_health's max(last_seen_at)
  // advances each run (the open-SOs sibling does this too). Without it,
  // last_seen_at only got its INSERT default and never moved for unchanged
  // PO lines, so the 'open_pos_planning' feed showed a FALSE 'stale' whenever
  // the open-PO set held steady >26h even though the nightly ran fine.
  const syncStartedAt = new Date().toISOString();

  // 1. Page through every PO row.
  const allPos = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from("tanda_pos")
      .select("po_number, data")
      .order("po_number", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return { ...result, error: "tanda_pos fetch failed", details: error.message };
    if (!data || data.length === 0) break;
    allPos.push(...data);
    if (data.length < PAGE) break;
  }
  result.pos_scanned = allPos.length;

  // 1b. Tanda milestone DDP dates — the ops-maintained expected arrival per PO,
  // used to refine each open-PO's expected_date so in-production supply (WIP)
  // lands in the right planning month. Best-effort: if milestones can't be read
  // we fall back to the Xoro payload date below (no behavior change).
  const ddpByPo = new Map();
  try {
    const milestoneRows = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin
        .from("tanda_milestones")
        .select("data")
        .eq("data->>days_before_ddp", "0")
        .range(offset, offset + 999);
      if (error || !data || data.length === 0) break;
      milestoneRows.push(...data);
      if (data.length < 1000) break;
    }
    for (const [k, v] of buildDdpDateMap(milestoneRows)) ddpByPo.set(k, v);
  } catch { /* milestones optional — fall back to Xoro dates */ }

  // 2. Item master.
  const itemMap = new Map();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .order("sku_code", { ascending: true })
      .range(offset, offset + 999);
    if (error) return { ...result, error: "item_master fetch failed", details: error.message };
    if (!data || data.length === 0) break;
    for (const r of data) itemMap.set(canonSku(r.sku_code), r.id);
    if (data.length < 1000) break;
  }

  // 2b. Customer master + supply-only placeholder.
  const customerByName = new Map();
  {
    const { data, error } = await admin
      .from("ip_customer_master")
      .select("id, customer_code, name");
    if (error) return { ...result, error: "customer_master fetch failed", details: error.message };
    for (const c of data ?? []) {
      const name = (c.name ?? "").trim().toUpperCase();
      const code = (c.customer_code ?? "").trim().toUpperCase();
      if (name) customerByName.set(name, c.id);
      if (code) customerByName.set(code, c.id);
    }
  }
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
      const { data: created, error: cErr } = await admin
        .from("ip_customer_master")
        .upsert([{ customer_code: SUPPLY_CODE, name: "(Supply Only)" }], {
          onConflict: "customer_code", ignoreDuplicates: false,
        })
        .select("id")
        .maybeSingle();
      if (cErr) return { ...result, error: "supply_only customer create failed", details: cErr.message };
      supplyOnlyId = created?.id ?? null;
    }
  }

  const STOCK_BUYER_RE = /(rof\s*stock|pt\s*stock|stock|none)/i;
  function resolveCustomerId(buyerName) {
    const raw = String(buyerName ?? "").trim();
    if (!raw || STOCK_BUYER_RE.test(raw)) return supplyOnlyId;
    const id = customerByName.get(raw.toUpperCase());
    return id ?? supplyOnlyId;
  }

  // 3. Flatten POs → line candidates.
  const candidates = [];
  const missingSkus = new Map();
  for (const r of allPos) {
    const po = r.data;
    if (!po) { result.skipped_no_lines++; continue; }
    if (po._archived === true) { result.skipped_archived++; continue; }

    const poNumber = String(po.PoNumber ?? r.po_number ?? "").trim();
    if (!poNumber) { result.skipped_no_lines++; continue; }
    if (poNumber.toUpperCase().includes("EOM")) { result.skipped_eom++; continue; }

    const lines = Array.isArray(po.PoLineArr) ? po.PoLineArr
                : Array.isArray(po.Items)     ? po.Items
                : Array.isArray(po.invoiceItemLineArr) ? po.invoiceItemLineArr
                : [];
    if (lines.length === 0) { result.skipped_no_lines++; continue; }

    const orderDate = toIsoDate(po.DateOrder);
    // Prefer the Tanda "In House / DDP" milestone date (ops-maintained arrival)
    // over the Xoro payload date so the in-production PO (WIP) is bucketed into
    // the correct planning month; fall back to the Xoro date when no milestone.
    const xoroExpected = toIsoDate(po.DateExpectedDelivery ?? po.VendorReqDate);
    const milestoneDdp = ddpByPo.get(poNumber) || null;
    const expectedDate = milestoneDdp || xoroExpected;
    if (milestoneDdp && milestoneDdp !== xoroExpected) result.expected_date_from_milestone++;
    const currency = po.CurrencyCode ?? null;
    const status = po.StatusName ?? null;
    const buyerName = po.BuyerName ?? null;
    const customerId = resolveCustomerId(buyerName);

    for (const ln of lines) {
      const rawSku = canonStyleColor(ln.ItemNumber ?? ln.Sku ?? ln.ItemCode);
      if (!rawSku) { result.skipped_no_sku++; continue; }
      // Resolve via PPK-strip fallback so prepack PO lines that
      // bake the size token into the item number ("STYLE-COLOR-PPKn")
      // attach to the existing canonical (style, color) master row
      // instead of triggering a missing-SKU stub-create.
      const stripped = rawSku.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, "");
      const sku = (stripped !== rawSku && itemMap.has(stripped)) ? stripped : rawSku;

      const qtyOrdered = toNum(ln.QtyOrder ?? ln.QtyOrdered ?? ln.Qty);
      const qtyReceived = toNum(ln.QtyReceived);
      const qtyOpen = toNum(ln.QtyRemaining ?? (qtyOrdered - qtyReceived));
      if (qtyOpen <= 0) { result.skipped_zero_open++; continue; }

      if (!itemMap.has(sku) && !missingSkus.has(sku)) missingSkus.set(sku, ln);

      const lineNum = String(ln.LineNumber ?? ln.Id ?? "").trim() || sku;
      candidates.push({
        sku, poNumber, lineNum,
        order_date: orderDate, expected_date: expectedDate,
        qtyOrdered, qtyReceived, qtyOpen,
        unit_cost: toNum(ln.UnitPrice) || null,
        currency, status,
        buyer_name: buyerName,
        customer_id: customerId,
      });
    }
  }

  // 4. Stub-create missing SKUs in master.
  if (missingSkus.size > 0) {
    // Size-grain DB fallback. Strip resolved SKUs out of missingSkus
    // so they don't get stub-created. See resolveSizeGrainFallback.
    await resolveSizeGrainFallback(admin, Array.from(missingSkus.keys()), itemMap);
    for (const sku of Array.from(missingSkus.keys())) {
      if (itemMap.has(sku)) missingSkus.delete(sku);
    }
  }
  if (missingSkus.size > 0) {
    const newItems = Array.from(missingSkus.keys()).map((sku) => buildItemRow(sku));
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
      result.auto_created_skus += chunk.length;
    }
  }

  // 5. Aggregate (po, sku) so multi-size lines collapse.
  const aggMap = new Map();
  for (const c of candidates) {
    const skuId = itemMap.get(c.sku);
    if (!skuId) { result.errors.push(`no id for ${c.sku} after bulk create`); continue; }
    const key = `tanda:${c.poNumber}:${c.sku}`;
    const prev = aggMap.get(key);
    if (!prev) {
      // Channel from po_number prefix. The customer's convention
      // is "ROF ECOM" / "ROF-ECOM" / "ROFECOM" at the start of the
      // PO number for ecom-bound orders — anything else is wholesale.
      // Regex tolerates whitespace / dash / underscore between ROF
      // and ECOM since the PO entry side hasn't standardized on a
      // separator. Case-insensitive.
      const channel = /^rof[\s_-]*ecom/i.test(c.poNumber ?? "") ? "ecom" : "wholesale";
      aggMap.set(key, {
        sku_id: skuId,
        po_number: c.poNumber,
        po_line_number: c.sku,
        order_date: c.order_date,
        expected_date: c.expected_date,
        qty_ordered: c.qtyOrdered,
        qty_received: c.qtyReceived,
        qty_open: c.qtyOpen,
        unit_cost: c.unit_cost,
        currency: c.currency,
        status: c.status,
        customer_id: c.customer_id,
        buyer_name: c.buyer_name,
        channel,
        source: "xoro",
        source_line_key: key,
        last_seen_at: syncStartedAt,
      });
      continue;
    }
    const totalOrdered = prev.qty_ordered + c.qtyOrdered;
    if (prev.unit_cost != null && c.unit_cost != null && totalOrdered > 0) {
      prev.unit_cost = (prev.unit_cost * prev.qty_ordered + c.unit_cost * c.qtyOrdered) / totalOrdered;
    } else if (c.unit_cost != null) {
      prev.unit_cost = c.unit_cost;
    }
    prev.qty_ordered += c.qtyOrdered;
    prev.qty_received += c.qtyReceived;
    prev.qty_open += c.qtyOpen;
    if (c.order_date && (!prev.order_date || c.order_date < prev.order_date)) prev.order_date = c.order_date;
    if (c.expected_date && (!prev.expected_date || c.expected_date > prev.expected_date)) prev.expected_date = c.expected_date;
  }
  const rows = Array.from(aggMap.values());

  // 6. Upsert before deleting stale, so the grid never sees an empty PO table.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_open_purchase_orders")
      .upsert(chunk, { onConflict: "source,source_line_key", ignoreDuplicates: false });
    if (error) result.errors.push(error.message);
    else result.inserted += chunk.length;
  }

  // 7. Prune POs that closed since the last sync.
  const newKeys = new Set(rows.map((r) => r.source_line_key));
  let staleOffset = 0;
  while (true) {
    const { data: existing, error: fetchErr } = await admin
      .from("ip_open_purchase_orders")
      .select("source_line_key")
      .eq("source", "xoro")
      .range(staleOffset, staleOffset + 999);
    if (fetchErr) { result.errors.push(`stale lookup: ${fetchErr.message}`); break; }
    if (!existing || existing.length === 0) break;

    const staleKeys = existing
      .map((r) => r.source_line_key)
      .filter((k) => k && !newKeys.has(k));

    for (let i = 0; i < staleKeys.length; i += 100) {
      const chunk = staleKeys.slice(i, i + 100);
      const { error } = await admin
        .from("ip_open_purchase_orders")
        .delete()
        .eq("source", "xoro")
        .in("source_line_key", chunk);
      if (error) result.errors.push(`stale cleanup: ${error.message}`);
      else result.cleaned += chunk.length;
    }

    if (existing.length < 1000) break;
    staleOffset += 1000;
  }

  return result;
}

// ── Historical receipts from PO WIP (tanda_pos) ──────────────────────────────
//
// The receipt data we already have lives in tanda_pos: every PO line carries a
// cumulative QtyReceived. Fully-received lines are (correctly) excluded from
// ip_open_purchase_orders — syncOpenPosFromTandaPos skips qty_open <= 0 — so
// they never reached the planning grid's "Hist Recv" column, which reads
// ip_receipts_history, a table nothing was populating. This flattens the
// received portion of every PO line into ip_receipts_history so historical
// receipts surface per SKU per period. No Xoro calls — pure DB transform.
//
// ⚠️ There is NO true receipt timestamp anywhere in the Xoro PO payload — only
// the cumulative QtyReceived plus the PO's expected/DDP delivery date. So
// received_date is that expected-arrival date (the ops-maintained milestone DDP
// when set, else the Xoro DateExpectedDelivery / VendorReqDate) — the same
// proxy the costing PO-history endpoint already uses. Receipts bucket by
// expected arrival, not a literal scan date; that is the best the source
// supports.

// Pure line extractor (unit-tested). Given one tanda_pos payload, returns its
// received sub-lines: [{ sku, qty, received_date, po_number }] at style+color
// grain. `received_date` may be null when the PO carries no expected date — the
// caller skips those (received_date is NOT NULL in the table). No DB, no sku_id.
export function extractReceiptLines(po, poNumberFallback, ddpByPo) {
  // NOTE: unlike the open-PO sync we do NOT skip _archived POs — a PO is
  // archived precisely when it is fully Received/Closed, which is exactly the
  // receipt history we want. Archived POs carry their lines under `Items`.
  if (!po) return [];
  const poNumber = String(po.PoNumber ?? poNumberFallback ?? "").trim();
  if (!poNumber) return [];
  if (poNumber.toUpperCase().includes("EOM")) return [];

  // Pick the FIRST NON-EMPTY line array. Fully-received/closed POs carry their
  // lines under `Items` while their `PoLineArr` is an empty [] — so a plain
  // Array.isArray check on PoLineArr would shadow Items and drop every historical
  // receipt. Open/released POs use PoLineArr. (The open-PO sync only reads the
  // open PoLineArr, so it never hit this.)
  const lines = (Array.isArray(po.PoLineArr) && po.PoLineArr.length) ? po.PoLineArr
              : (Array.isArray(po.Items) && po.Items.length) ? po.Items
              : (Array.isArray(po.invoiceItemLineArr) && po.invoiceItemLineArr.length) ? po.invoiceItemLineArr
              : [];
  if (lines.length === 0) return [];

  // Date proxy: prefer the ops milestone DDP arrival (for in-production POs),
  // else the PO header's expected/vendor-requested date. Overridden per line
  // below by the line's own expected date when present (historical Items lines
  // carry their own DateExpectedDelivery, which is the actual delivery date).
  const milestoneDdp = (ddpByPo && typeof ddpByPo.get === "function" && ddpByPo.get(poNumber)) || null;
  const headerDate = milestoneDdp || toIsoDate(po.DateExpectedDelivery ?? po.VendorReqDate) || null;

  const out = [];
  for (const ln of lines) {
    const sku = canonStyleColor(ln.ItemNumber ?? ln.Sku ?? ln.ItemCode);
    if (!sku) continue;
    const qty = toNum(ln.QtyReceived);
    if (qty <= 0) continue;
    const received_date = milestoneDdp || toIsoDate(ln.DateExpectedDelivery) || headerDate;
    out.push({ sku, qty, received_date, po_number: poNumber });
  }
  return out;
}

// Flatten every received PO line in tanda_pos into ip_receipts_history.
// Idempotent: upserts on (source, source_line_key = tanda:<po>:<sku>) and prunes
// its own stale rows, so re-running just reconciles. source='tanda' keeps these
// derived rows distinct from any future true item-receipt feed.
export async function syncReceiptsFromTandaPos(admin) {
  const result = {
    pos_scanned: 0,
    inserted: 0,
    skipped_no_lines: 0,
    skipped_no_receipts: 0,
    skipped_no_date: 0,
    skipped_no_sku: 0,
    cleaned: 0,
    errors: [],
  };

  // 1. Page through every PO row.
  const allPos = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from("tanda_pos")
      .select("po_number, data")
      .order("po_number", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return { ...result, error: "tanda_pos fetch failed", details: error.message };
    if (!data || data.length === 0) break;
    allPos.push(...data);
    if (data.length < PAGE) break;
  }
  result.pos_scanned = allPos.length;

  // 1b. Milestone DDP map — same receipt-date proxy as the open-PO sync.
  const ddpByPo = new Map();
  try {
    const milestoneRows = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin
        .from("tanda_milestones")
        .select("data")
        .eq("data->>days_before_ddp", "0")
        .range(offset, offset + 999);
      if (error || !data || data.length === 0) break;
      milestoneRows.push(...data);
      if (data.length < 1000) break;
    }
    for (const [k, v] of buildDdpDateMap(milestoneRows)) ddpByPo.set(k, v);
  } catch { /* milestones optional — fall back to Xoro dates */ }

  // 2. Item master.
  const itemMap = new Map();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .order("sku_code", { ascending: true })
      .range(offset, offset + 999);
    if (error) return { ...result, error: "item_master fetch failed", details: error.message };
    if (!data || data.length === 0) break;
    for (const r of data) itemMap.set(canonSku(r.sku_code), r.id);
    if (data.length < 1000) break;
  }

  // 3. Flatten received lines → candidates.
  const candidates = [];
  const missingSkus = new Map();
  for (const r of allPos) {
    const po = r.data;
    if (!po) { result.skipped_no_lines++; continue; }
    // Archived (Received/Closed) POs are the bulk of the receipt history — keep
    // them. skipped_archived stays for shape parity but is not incremented.
    const recLines = extractReceiptLines(po, r.po_number, ddpByPo);
    if (recLines.length === 0) { result.skipped_no_receipts++; continue; }
    for (const rl of recLines) {
      if (!rl.received_date) { result.skipped_no_date++; continue; }
      // PPK-strip fallback so prepack PO lines that bake the size token into the
      // item number attach to the existing canonical (style, color) master —
      // identical to syncOpenPosFromTandaPos.
      const stripped = rl.sku.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, "");
      const sku = (stripped !== rl.sku && itemMap.has(stripped)) ? stripped : rl.sku;
      if (!itemMap.has(sku) && !missingSkus.has(sku)) missingSkus.set(sku, rl);
      candidates.push({ sku, qty: rl.qty, received_date: rl.received_date, po_number: rl.po_number });
    }
  }

  // 4. Resolve missing SKUs against EXISTING masters via the size-grain
  // fallback — but do NOT stub-create. Receipts are historical (back to 2024)
  // and include long-discontinued styles; creating master rows for them would
  // pollute the item master with SKUs that never appear in a planning run (the
  // Hist Recv column only shows for SKUs already in the run). Unresolved lines
  // are counted as skipped_no_sku below and simply not recorded.
  if (missingSkus.size > 0) {
    await resolveSizeGrainFallback(admin, Array.from(missingSkus.keys()), itemMap);
  }

  // 5. Aggregate (po, sku) so multi-size lines collapse to one receipt row.
  const aggMap = new Map();
  for (const c of candidates) {
    const skuId = itemMap.get(c.sku);
    if (!skuId) { result.skipped_no_sku++; continue; }
    const key = `tanda:${c.po_number}:${c.sku}`;
    const prev = aggMap.get(key);
    if (!prev) {
      aggMap.set(key, {
        sku_id: skuId,
        po_number: c.po_number,
        received_date: c.received_date,
        qty: c.qty,
        source: "tanda",
        source_line_key: key,
      });
      continue;
    }
    prev.qty += c.qty;
    // Latest expected date wins, mirroring the open-PO aggregate.
    if (c.received_date && (!prev.received_date || c.received_date > prev.received_date)) {
      prev.received_date = c.received_date;
    }
  }
  const rows = Array.from(aggMap.values());

  // 6. Upsert.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_receipts_history")
      .upsert(chunk, { onConflict: "source,source_line_key", ignoreDuplicates: false });
    if (error) result.errors.push(error.message);
    else result.inserted += chunk.length;
  }

  // 7. Prune our own stale rows (a PO whose received qty was reversed to 0, or a
  // PO removed from tanda_pos). Only touches source='tanda'.
  const newKeys = new Set(rows.map((r) => r.source_line_key));
  let staleOffset = 0;
  while (true) {
    const { data: existing, error: fetchErr } = await admin
      .from("ip_receipts_history")
      .select("source_line_key")
      .eq("source", "tanda")
      .range(staleOffset, staleOffset + 999);
    if (fetchErr) { result.errors.push(`stale lookup: ${fetchErr.message}`); break; }
    if (!existing || existing.length === 0) break;
    const staleKeys = existing
      .map((r) => r.source_line_key)
      .filter((k) => k && !newKeys.has(k));
    for (let i = 0; i < staleKeys.length; i += 100) {
      const chunk = staleKeys.slice(i, i + 100);
      const { error } = await admin
        .from("ip_receipts_history")
        .delete()
        .eq("source", "tanda")
        .in("source_line_key", chunk);
      if (error) result.errors.push(`stale cleanup: ${error.message}`);
      else result.cleaned += chunk.length;
    }
    if (existing.length < 1000) break;
    staleOffset += 1000;
  }

  return result;
}

// ── Xoro by-size on-hand → planning snapshot (single-source-of-truth, PR1) ────
//
// Design: docs/tangerine/onhand-single-source-of-truth.md. The goal is for
// planning on-hand and the Tangerine on-hand feed to be identical by reading
// ONE source. `tangerine_size_onhand` is the Xoro REST by-size pull (the truth,
// per warehouse). This re-sources it into `ip_inventory_snapshot` under
// source='tangerine', so planning's existing reader can consume the Xoro truth.
//
// Both tables are SIZE grain and FK to the SAME ip_item_master, so item_id →
// sku_id is identity — this is a re-source (per warehouse), NOT a roll-up. PPK
// stays in native grain (packs), exactly like the legacy source='manual' rows;
// the planning grid expands packs→eaches at display, so PPK normalization is
// unchanged and consistent. Zero-on-hand rows are carried through (whatever the
// pull reports). This is ADDITIVE — it does not touch source='manual' (ATS)
// rows; the reader flip is a later PR.
export async function rollUpXoroOnHandToSnapshot(admin) {
  const result = { snapshot_date: null, rows_read: 0, upserted: 0, warehouses: [], errors: [] };

  // 1. Latest snapshot_date available in the Xoro by-size feed.
  {
    const { data, error } = await admin
      .from("tangerine_size_onhand")
      .select("snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { ...result, error: "tangerine_size_onhand date fetch failed", details: error.message };
    if (!data?.snapshot_date) return { ...result, error: "tangerine_size_onhand is empty" };
    result.snapshot_date = data.snapshot_date;
  }

  // 2. Page the by-size on-hand at that date and re-source into ip_inventory_snapshot.
  const whSet = new Set();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from("tangerine_size_onhand")
      .select("item_id, warehouse_code, qty_on_hand")
      .eq("snapshot_date", result.snapshot_date)
      .order("item_id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return { ...result, error: "tangerine_size_onhand fetch failed", details: error.message };
    if (!data || data.length === 0) break;
    result.rows_read += data.length;

    const rows = data.map((r) => {
      if (r.warehouse_code) whSet.add(r.warehouse_code);
      return {
        sku_id: r.item_id,
        warehouse_code: r.warehouse_code,
        snapshot_date: result.snapshot_date,
        qty_on_hand: r.qty_on_hand ?? 0,
        source: "tangerine",
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error: upErr } = await admin
        .from("ip_inventory_snapshot")
        .upsert(chunk, { onConflict: "sku_id,warehouse_code,snapshot_date,source", ignoreDuplicates: false });
      if (upErr) result.errors.push(upErr.message);
      else result.upserted += chunk.length;
    }
    if (data.length < PAGE) break;
  }
  result.warehouses = Array.from(whSet).sort();
  return result;
}
