// api/_handlers/xoro/open-sos.js
//
// Pulls open Sales Orders from Xoro and writes the raw payload to
// raw_xoro_payloads. The "open" set in our planner = Xoro's
// `status=Released` (~26 pages × 200 rows = ~5,200 SOs at last probe).
// Comfortably one-shot inside Vercel's 300s budget; no chunking needed.
//
// Why status=Released: empirical probe showed Xoro's salesorder endpoint
// recognises `status=` (lowercase OR `Status=` capital) but the value
// "Open" returns 0 pages. Released = 26, Partially Shipped = 1,
// Shipped = 171, Closed = 81. Released is the lifecycle stage where the
// order is committed to fulfillment but not yet shipped — the planner's
// definition of "open commitments".
//
// Auth: ATS App private app (scope "Inventory and Sales Orders" — the
// Sales-Orders half). Maps to module=items per xoro-client.js's existing
// VITE_XORO_ITEMS_API_KEY/SECRET convention.
//
// Query params:
//   status              SO status filter (default: Released). Pass
//                       comma-separated list to walk multiple statuses
//                       sequentially; the response includes a per-status
//                       record_count.
//   date_from / date_to optional date window filters (passed through to
//                       Xoro). Endpoint accepts but doesn't strictly
//                       require these — empirical, not documented.
//   path                Xoro endpoint override (default: salesorder/getsalesorder)
//   module              API-key bundle override (default: items)
//   page_start / max_pages  chunked-sync controls if the Released set
//                           grows past one-call territory.

import { fetchXoroAll } from "../../_lib/xoro-client.js";
import { insertRawXoro, supabaseAdminFromEnv } from "../../_lib/planning-raw.js";

export const config = { maxDuration: 300 };

const SO_PATH = "salesorder/getsalesorder";

// Xoro SO records are huge (100+ fields per header alone, 12.5MB at
// per_page=200). The client only needs a handful for normalizing into
// ATSSoEvent. Strip on the server to cut per-page response size by ~25x
// and drop transfer time correspondingly. raw_xoro_payloads still gets
// the full payload for archival/reprocessing; only the response back
// to the client is trimmed.
function trimSoRecord(rec) {
  const h = rec?.SoEstimateHeader ?? {};
  const lines = Array.isArray(rec?.SoEstimateItemLineArr) ? rec.SoEstimateItemLineArr : [];
  return {
    SoEstimateHeader: {
      OrderNumber: h.OrderNumber ?? null,
      CustomerFullName: h.CustomerFullName ?? null,
      CustomerName: h.CustomerName ?? null,
      StoreName: h.StoreName ?? null,
      SaleStoreName: h.SaleStoreName ?? null,
      DateToBeShipped: h.DateToBeShipped ?? null,
    },
    SoEstimateItemLineArr: lines.map((l) => ({
      ItemNumber: l?.ItemNumber ?? null,
      QtyRemainingToShip: l?.QtyRemainingToShip ?? null,
      QtyOrdered: l?.QtyOrdered ?? null,
      Qty: l?.Qty ?? null,
      UnitPrice: l?.UnitPrice ?? null,
      LineAmount: l?.LineAmount ?? null,
      DateToBeShipped: l?.DateToBeShipped ?? null,
    })),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const admin = supabaseAdminFromEnv();
  if (!admin) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || SO_PATH;
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const statusList = (url.searchParams.get("status") || "Released")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const pageStart = Math.max(parseInt(url.searchParams.get("page_start") || "1", 10), 1);
  const maxPages = Math.min(parseInt(url.searchParams.get("max_pages") || "50", 10), 200);
  const module = url.searchParams.get("module") || "items";

  const perStatus = [];
  let totalRecords = 0;
  let firstError = null;

  // Walk one status at a time so a failure on one (e.g. Xoro chokes on
  // "Partially Shipped" with the space encoded) doesn't lose the others.
  for (const status of statusList) {
    const params = { per_page: "200", status };
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;

    const r = await fetchXoroAll({ path, params, pageStart, maxPages, module });
    if (!r.ok || !r.body?.Result) {
      perStatus.push({ status, ok: false, xoro: r.body });
      if (!firstError) firstError = r.body;
      continue;
    }
    const data = Array.isArray(r.body.Data) ? r.body.Data : [];

    const raw = await insertRawXoro(admin, {
      endpoint: "open-sos",
      params: { ...params, path, page_start: pageStart, max_pages: maxPages },
      payload: { data, status },
      periodStart: dateFrom || null,
      periodEnd: dateTo || null,
      recordCount: data.length,
      ingestedBy: "api/xoro/open-sos",
    });
    if (raw.error) {
      perStatus.push({ status, ok: false, raw_error: raw.error });
      continue;
    }

    totalRecords += data.length;
    perStatus.push({
      status,
      ok: true,
      raw_payload_id: raw.id,
      deduped: raw.deduped,
      record_count: data.length,
      total_pages: r.body.TotalPages ?? null,
      // Trimmed records — only the fields the client needs to normalize
      // into ATSSoEvent. Cuts response size from ~12.5MB to ~500KB per
      // page. raw_xoro_payloads still has the full payload (above) for
      // archival / future reprocessing if more fields are needed.
      records: data.map(trimSoRecord),
    });
  }

  const anyOk = perStatus.some((p) => p.ok);
  return res.status(200).json({
    ok: anyOk,
    statuses_walked: statusList,
    total_records: totalRecords,
    per_status: perStatus,
    first_error: firstError,
    page_start: pageStart,
    max_pages: maxPages,
    module,
  });
}
