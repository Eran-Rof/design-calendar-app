// api/_handlers/xoro/probe-filters.js
//
// Diagnostic-only handler. Hits Xoro with a matrix of (path, filter)
// candidates so we can see empirically which paths exist and which
// filter params Xoro actually honors. No Supabase writes.
//
// Why this exists: the inventory file is ~20k rows and a single
// fetch_all run blows past Vercel's 300s budget. Before paying for
// chunking infrastructure we need to know if Xoro has a server-side
// filter that narrows the catalog (warehouse, modified_since, etc.).
// The sales path has the same question for "Open SOs by ship month".
//
// What the response means:
//   - ok=true & result=true & data_count=N → path works, returned N rows on page 1
//   - data_count drops vs the baseline (no-filter) call → filter is honored
//   - total_pages present → use it for chunk planning; if absent, Xoro
//     hides the page count (then we'd binary-search like xoro-sales-sync does)
//   - first_record_keys lists the fields Xoro returns, so we can spot
//     filter param names we hadn't guessed (e.g. WarehouseCode vs warehouse_id)
//
// Query params:
//   endpoint=inventory|sales|all   (default: all)
//   warehouse=<code>               (used by the warehouse-filter probes)
//   modified_since=YYYY-MM-DD      (used by the modified-since probes)
//   date_from=YYYY-MM-DD           (used by the SO date probes)
//   date_to=YYYY-MM-DD
//   module=items|sales|default     (which API key bundle to use; default: items)
//
// Each Xoro call uses per_page=1 to keep the probe cheap; the only
// signal we want is Result, Message, TotalPages, and first record shape.

import { fetchXoro, fetchXoroAll } from "../../_lib/xoro-client.js";

export const config = { maxDuration: 300 };

// Path candidates per surface. Pulled from Xoro's documented modules and
// from paths already exercised elsewhere in the repo (xoro-proxy allowlist,
// xoro-sales-sync, etc.). Every path is exact "module/action" — case is
// preserved as Xoro is sometimes case-sensitive.
const INVENTORY_PATHS = [
  "inventory/getinventory",
  "inventory/getitemavailability",
  "itemavailability/getitemavailability",
  "stockonhand/getstockonhand",
  "inventorystatus/getinventorystatus",
  "iteminventory/getiteminventory",
];

const SALES_ORDER_PATHS = [
  "salesorder/getsalesorder",
  "salesorders/getsalesorders",
  "so/getso",
  "salesorderlist/getsalesorderlist",
];

// Filter param-name candidates per dimension. Probes try one filter at
// a time vs the baseline (no filter) so we can attribute any change in
// data_count / total_pages to that specific param.
function inventoryFilterMatrix({ warehouse, modifiedSince }) {
  const cases = [{ label: "baseline_no_filter", params: {} }];
  if (warehouse) {
    for (const k of ["warehouse", "warehouse_id", "WarehouseCode", "WarehouseId", "warehouse_code", "StoreCode"]) {
      cases.push({ label: `warehouse_via_${k}`, params: { [k]: warehouse } });
    }
  } else {
    cases.push({ label: "warehouse_skipped", params: {}, note: "no ?warehouse= supplied" });
  }
  if (modifiedSince) {
    for (const k of ["modified_since", "ModifiedSince", "modified_after", "updated_since", "UpdatedSince"]) {
      cases.push({ label: `modified_via_${k}`, params: { [k]: modifiedSince } });
    }
  }
  cases.push({ label: "active_only", params: { active: "true" } });
  cases.push({ label: "qty_gt_zero", params: { qty_gt: "0" } });
  cases.push({ label: "in_stock_flag", params: { in_stock: "true" } });
  return cases;
}

function salesOrderFilterMatrix({ dateFrom, dateTo, modifiedSince }) {
  const cases = [{ label: "baseline_no_filter", params: {} }];
  // status filter
  for (const v of ["Open", "open", "OPEN"]) {
    cases.push({ label: `status_${v}`, params: { status: v } });
  }
  cases.push({ label: "Status_Open_capital", params: { Status: "Open" } });
  cases.push({ label: "OrderStatus_Open", params: { OrderStatus: "Open" } });
  // date filters — try the param-name pairs the team has already seen
  if (dateFrom && dateTo) {
    cases.push({ label: "date_from_to", params: { date_from: dateFrom, date_to: dateTo } });
    cases.push({ label: "from_date_to_date", params: { from_date: dateFrom, to_date: dateTo } });
    cases.push({ label: "OrderDateFrom_To", params: { OrderDateFrom: dateFrom, OrderDateTo: dateTo } });
    cases.push({ label: "ShipDateFrom_To", params: { ShipDateFrom: dateFrom, ShipDateTo: dateTo } });
    cases.push({ label: "TxnDate_range", params: { TxnDateFrom: dateFrom, TxnDateTo: dateTo } });
  }
  if (modifiedSince) {
    cases.push({ label: "modified_since", params: { modified_since: modifiedSince } });
    cases.push({ label: "ModifiedSince_capital", params: { ModifiedSince: modifiedSince } });
  }
  return cases;
}

async function probeOne({ path, params, module }) {
  const t0 = Date.now();
  // Use fetchXoroAll with maxPages=1 so the probe inherits the same
  // 0/800/2000/4000ms retry chain that production syncs rely on. Xoro
  // 500s intermittently — without retries every probe looked broken
  // even on paths xoro-items-missing-sync.js calls successfully every day.
  // per_page=500 matches the working production callers (xoro/items.js,
  // xoro-items-missing-sync.js).
  const r = await fetchXoroAll({ path, params: { ...params, per_page: "500" }, maxPages: 1, module });
  const elapsedMs = Date.now() - t0;
  const body = r.body ?? {};
  const data = Array.isArray(body.Data) ? body.Data : [];
  const first = data[0] ?? null;
  return {
    ok: !!r.ok,
    http_status: r.status,
    result: body.Result ?? null,
    message: body.Message ?? null,
    data_count: data.length,
    total_pages: body.TotalPages ?? null,
    first_record_keys: first && typeof first === "object" ? Object.keys(first).slice(0, 60) : null,
    page_notes: body._pageCounts ?? null,
    elapsed_ms: elapsedMs,
  };
}

// Try the same path under each available API-key module so we know which
// credential bundle has access to it. Returns the first success; if all
// fail returns the last attempt for the error message.
async function probeAcrossModules({ path, params, modules }) {
  const attempts = [];
  for (const m of modules) {
    const r = await probeOne({ path, params, module: m });
    attempts.push({ module: m, ...r });
    if (r.ok && r.result === true) return { winning_module: m, attempts, ...r };
  }
  const last = attempts[attempts.length - 1];
  return { winning_module: null, attempts, ...last };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const which = (url.searchParams.get("endpoint") || "all").toLowerCase();
  const module = url.searchParams.get("module") || "items";
  const warehouse = url.searchParams.get("warehouse") || "";
  const modifiedSince = url.searchParams.get("modified_since") || "";
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";

  const out = {
    module,
    inputs: { warehouse, modifiedSince, dateFrom, dateTo },
    items_field_dump: null,
    inventory: null,
    sales_orders: null,
    summary: { total_probes: 0, paths_responding: [], filters_that_changed_total_pages: [] },
  };

  // ITEMS FIELD DUMP ──────────────────────────────────────────────────────
  // The items endpoint already works in xoro-items-missing-sync. Pull a
  // single item with every field expanded so we can see if Xoro embeds
  // inventory data (QtyOnHand, QtyAvailable, WarehouseInventory[]) on the
  // item record itself — if it does, we don't need a separate endpoint.
  // Tries each API-key module to find which credential has read access.
  const MODULES_TO_TRY = ["items", "default", "sales"];
  if (which === "all" || which === "items" || which === "inventory") {
    const itemProbe = await probeAcrossModules({ path: "item/getitem", params: {}, modules: MODULES_TO_TRY });
    out.summary.total_probes += itemProbe.attempts.length;
    out.items_field_dump = {
      probe: itemProbe,
      first_record_full: null,
    };
    if (itemProbe.winning_module) {
      out.summary.paths_responding.push(`items:item/getitem[module=${itemProbe.winning_module}]`);
      // Re-fetch with the winning module to capture the full record body
      // (probeOne only kept the keys list). Use fetchXoroAll for the same
      // retry behaviour.
      const full = await fetchXoroAll({ path: "item/getitem", params: { per_page: "500" }, maxPages: 1, module: itemProbe.winning_module });
      const firstRec = Array.isArray(full.body?.Data) ? full.body.Data[0] : null;
      out.items_field_dump.first_record_full = firstRec;
      out.summary.total_probes++;
    }
  }

  // INVENTORY ─────────────────────────────────────────────────────────────
  if (which === "all" || which === "inventory") {
    const inv = { paths: {} };
    const filters = inventoryFilterMatrix({ warehouse, modifiedSince });
    for (const path of INVENTORY_PATHS) {
      // First, baseline (no filter) so we can compare TotalPages deltas.
      const baseline = await probeOne({ path, params: {}, module });
      const pathResults = { baseline, filtered: [] };
      out.summary.total_probes++;
      // Skip filter probes if the path itself doesn't respond — saves time.
      if (baseline.ok && baseline.result === true) {
        out.summary.paths_responding.push(`inventory:${path}`);
        for (const c of filters) {
          if (c.label === "baseline_no_filter") continue; // covered by `baseline`
          if (Object.keys(c.params).length === 0) {
            pathResults.filtered.push({ ...c, _skipped: "no params" });
            continue;
          }
          const probe = await probeOne({ path, params: c.params, module });
          out.summary.total_probes++;
          const tpDelta = baseline.total_pages != null && probe.total_pages != null
            ? baseline.total_pages - probe.total_pages
            : null;
          if (tpDelta != null && tpDelta > 0) {
            out.summary.filters_that_changed_total_pages.push({
              endpoint: "inventory", path, filter: c.label, baseline_pages: baseline.total_pages, filtered_pages: probe.total_pages,
            });
          }
          pathResults.filtered.push({ label: c.label, params: c.params, ...probe, total_pages_delta: tpDelta });
        }
      }
      inv.paths[path] = pathResults;
    }
    out.inventory = inv;
  }

  // SALES ORDERS ──────────────────────────────────────────────────────────
  if (which === "all" || which === "sales") {
    const so = { paths: {} };
    const filters = salesOrderFilterMatrix({ dateFrom, dateTo, modifiedSince });
    for (const path of SALES_ORDER_PATHS) {
      const baseline = await probeOne({ path, params: {}, module });
      const pathResults = { baseline, filtered: [] };
      out.summary.total_probes++;
      if (baseline.ok && baseline.result === true) {
        out.summary.paths_responding.push(`sales:${path}`);
        for (const c of filters) {
          if (c.label === "baseline_no_filter") continue;
          const probe = await probeOne({ path, params: c.params, module });
          out.summary.total_probes++;
          const tpDelta = baseline.total_pages != null && probe.total_pages != null
            ? baseline.total_pages - probe.total_pages
            : null;
          if (tpDelta != null && tpDelta > 0) {
            out.summary.filters_that_changed_total_pages.push({
              endpoint: "sales", path, filter: c.label, baseline_pages: baseline.total_pages, filtered_pages: probe.total_pages,
            });
          }
          pathResults.filtered.push({ label: c.label, params: c.params, ...probe, total_pages_delta: tpDelta });
        }
      }
      so.paths[path] = pathResults;
    }
    out.sales_orders = so;
  }

  return res.status(200).json(out);
}
