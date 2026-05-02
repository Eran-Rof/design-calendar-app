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

function toNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Wholesale planning is wholesale-only. ECOM rows from the ATS Excel snapshot
// (e.g. store="ROF ECOM") must NOT contribute to wholesale on-hand or wholesale
// open SOs — they are a separate channel with their own stock pool.
function isEcomStore(store) {
  if (!store) return false;
  return /ECOM/i.test(String(store));
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
//   2. Bulk-upsert ip_inventory_snapshot rows for today's date
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
    skipped_ecom: 0,
    snapshot_date: new Date().toISOString().slice(0, 10),
    so_lines_total: 0,
    so_lines_inserted: 0,
    so_lines_pruned: 0,
    so_lines_skipped_ecom: 0,
    so_customers_created: 0,
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

  let parsed;
  try {
    parsed = typeof appRow.value === "string" ? JSON.parse(appRow.value) : appRow.value;
  } catch (e) {
    return { ...result, error: "ATS snapshot is not valid JSON", details: String(e) };
  }

  const allSkus = Array.isArray(parsed?.skus) ? parsed.skus : [];
  result.ats_skus_total = allSkus.length;
  if (allSkus.length === 0) {
    return { ...result, error: "ATS snapshot has no SKU array", parsed_keys: Object.keys(parsed ?? {}) };
  }

  const skus = allSkus.slice(start, start + limit);
  result.ats_skus_in_batch = skus.length;
  const nextStart = start + limit >= allSkus.length ? null : start + limit;
  result.next_start = nextStart;
  result.done = nextStart === null;

  // Aggregate at style+color grain so multi-size lines collapse.
  const aggMap = new Map();
  for (const s of skus) {
    if (isEcomStore(s.store)) { result.skipped_ecom++; continue; }
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
  const itemMap = new Map();
  const candidateSkus = candidates.map((c) => c.sku);
  for (let i = 0; i < candidateSkus.length; i += 200) {
    const chunk = candidateSkus.slice(i, i + 200);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .in("sku_code", chunk);
    if (error) return { ...result, error: "item_master fetch failed", details: error.message };
    for (const r of data ?? []) itemMap.set(canonSku(r.sku_code), r.id);
  }

  // Stub-create any SKU not in master. NEVER write description / cost — the
  // Item Master Excel is the SOLE source of those fields.
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

  // Build snapshot rows.
  const today = result.snapshot_date;
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
    const rawSos = parsed.sos;
    const allSos = rawSos.filter(so => !isEcomStore(so.store));
    result.so_lines_skipped_ecom = rawSos.length - allSos.length;
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

    const soAgg = new Map();
    for (const so of allSos) {
      const sku = canonStyleColor(so.sku);
      if (!sku) continue;
      const skuId = itemMap.get(sku);
      if (!skuId) continue;
      const shipDate = so.date ? String(so.date).slice(0, 10) : null;
      if (!shipDate) continue;
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
    const expectedDate = toIsoDate(po.DateExpectedDelivery ?? po.VendorReqDate);
    const currency = po.CurrencyCode ?? null;
    const status = po.StatusName ?? null;
    const buyerName = po.BuyerName ?? null;
    const customerId = resolveCustomerId(buyerName);

    for (const ln of lines) {
      const sku = canonStyleColor(ln.ItemNumber ?? ln.Sku ?? ln.ItemCode);
      if (!sku) { result.skipped_no_sku++; continue; }

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
        source: "xoro",
        source_line_key: key,
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
