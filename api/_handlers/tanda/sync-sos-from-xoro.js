// POST /api/tanda/sync-sos-from-xoro — server-side Xoro→tanda_sos refresh.
//
// The SO counterpart of tanda/sync-from-xoro.js. It populates the rich
// `tanda_sos` mirror (migration 20260897000000) so a faithful native SO
// import (sales_orders/_lines with real statuses, dates, customer PO, and
// per-size lines) has a complete source — the ATS blob the nightly writes is
// CSV-derived and lossy (style-color grain only, no rich header, no cancel
// date). Chain:
//
//   Xoro  ──(this endpoint)──▶  tanda_sos  ──(scripts/import-xoro-orders.mjs)──▶  sales_orders/_lines
//
// Endpoint: salesorder/getsalesorder. CRITICAL: despite the "salesorder" path
// this lives under the ATS-App ("items") credentials — the Sales-History creds
// return HTTP 500 (see rof_xoro_project/scripts/rest_sales_orders_sync.py). It
// REQUIRES a `status=<name>` query param; without it Xoro returns Result:true
// Data:[] (the empty-default-scope footgun). It returns wrapped
// { SoEstimateHeader, SoEstimateItemLineArr } records, which we flatten into
// the flat shape tanda_sos / the importer expect.
//
// Active-supply statuses are 'Released' (the bulk) + 'Partially Shipped'. We
// also fetch the terminal statuses ('Shipped', 'Invoiced', 'Closed',
// 'Cancelled') so the mirror carries finished orders too (the operator asked
// for ALL SOs + statuses) — guarded by a per-status page cap to stay under the
// Vercel 300s function ceiling. Pass { active_only: true } in the body to fetch
// active statuses only.
//
// Auth: bearer DESIGN_CALENDAR_API_TOKEN (same gate the other scriptable
// Design-Calendar endpoints use).

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll } from "../../_lib/xoro-client.js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

export const config = { maxDuration: 300 };

const SO_PATH = "salesorder/getsalesorder";
const ACTIVE_STATUSES = ["Released", "Partially Shipped"];
const TERMINAL_STATUSES = ["Shipped", "Invoiced", "Closed", "Cancelled"];

// Per-status page cap: SO line fanout is heavy (Macy's-sized orders run to
// hundreds of lines / page). The active statuses get the full walk; terminal
// statuses are capped so the whole 6-status fan-out stays under maxDuration.
const ACTIVE_MAX_PAGES = 60;
const TERMINAL_MAX_PAGES = 25;

function toIsoDate(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s || s.startsWith("01/01/0001") || s.startsWith("0001-01-01")) return null;
  s = s.split(" ")[0].split("T")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = s.split("/");
  if (p.length === 3) {
    const m = +p[0], d = +p[1], y = +p[2];
    if (y < 1900 || !m || !d) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

// Flatten Xoro's wrapped SO shape ({ SoEstimateHeader, SoEstimateItemLineArr })
// into a flat shape with hoisted header fields + Items[]. Mirrors
// rof_xoro_project/scripts/rest_sales_orders_sync.py::expand_so field reads so
// the importer (scripts/import-xoro-orders.mjs) sees the same names POs use.
function flattenXoroSo(raw) {
  const h = raw?.SoEstimateHeader ?? raw?.soHeader ?? raw ?? {};
  const lines = Array.isArray(raw?.SoEstimateItemLineArr) ? raw.SoEstimateItemLineArr
              : Array.isArray(raw?.SoLineArr) ? raw.SoLineArr
              : Array.isArray(raw?.Items) ? raw.Items
              : [];
  const customerName =
    h.CustomerFullName ?? h.CustomerName ?? h.BillToCompanyName ?? h.BillToName ?? "";
  return {
    SoNumber:        h.OrderNumber ?? h.SoNumber ?? "",
    OrderNumber:     h.OrderNumber ?? h.SoNumber ?? "",
    CustomerName:    customerName,
    CustomerFullName: customerName,
    BrandName:       h.BrandName ?? h.Brand ?? "",
    SaleStoreName:   h.SaleStoreName ?? h.StoreName ?? "",
    CustomerPO:      h.CustomerPO ?? h.CustomerPo ?? "",
    StatusName:      h.StatusName ?? "",
    CurrencyCode:    h.CurrencyCode ?? "USD",
    DateOrder:       h.DateOrder ?? h.DateCreated ?? h.OrderDate ?? "",
    DateToBeShipped: h.DateToBeShipped ?? h.LastDateToBeShipped ?? "",
    DateToBeCancelled: h.DateToBeCancelled ?? "",
    PaymentTermsName: h.PaymentTermsName ?? "",
    Memo:            h.Memo ?? "",
    TotalAmount:     h.TotalAmount ?? 0,
    Items: lines.map((l) => {
      const color = l.Option1Value ?? l.OptionValue1 ?? null;
      const size = l.Option2Value ?? l.OptionValue2 ?? null;
      return {
        ItemNumber:  l.ItemNumber ?? "",
        BasePartNumber: l.BasePartNumber ?? l.BasePart ?? "",
        Color:       color,
        Size:        size,
        Description: l.Description ?? l.Title ?? "",
        QtyOrder:    l.Qty ?? l.QtyOrdered ?? 0,
        QtyShipped:  l.QtyShipped ?? 0,
        QtyAllocated: l.QtyAllocated ?? l.QtyCommitted ?? 0,
        UnitPrice:   l.UnitPrice ?? l.EffectiveUnitPrice ?? 0,
        StatusName:  l.StatusName ?? l.Status ?? "",
        DateToBeShipped: l.DateToBeShipped ?? "",
      };
    }),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const tokenTail = (req.headers.authorization || "").slice(-8) || "anon";
  const rl = rateLimit(`tanda-sync-sos-from-xoro:${tokenTail}`, { limit: 12, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const activeOnly = req.body?.active_only === true;
  const statuses = activeOnly ? ACTIVE_STATUSES : [...ACTIVE_STATUSES, ...TERMINAL_STATUSES];

  const requestId = randomUUID();
  const result = {
    request_id: requestId,
    statuses_fetched: statuses,
    xoro_pages_walked: 0,
    xoro_sos_returned: 0,
    sos_unique_after_dedup: 0,
    upserted: 0,
    skipped_no_so_number: 0,
    per_status: [],
    errors: [],
  };

  try {
    // 1. Fan out sequentially across statuses (parallel trips Xoro rate limits).
    //    salesorder/getsalesorder REQUIRES status= (empty-default footgun).
    const allRaw = [];
    for (const status of statuses) {
      const maxPages = ACTIVE_STATUSES.includes(status) ? ACTIVE_MAX_PAGES : TERMINAL_MAX_PAGES;
      const r = await fetchXoroAll({
        path: SO_PATH,
        params: { per_page: "100", status },
        module: "items",
        maxPages,
      });
      const pageCount = Array.isArray(r.body?._pageCounts) ? r.body._pageCounts.length : 0;
      const records = Array.isArray(r.body?.Data) ? r.body.Data : [];
      result.xoro_pages_walked += pageCount;
      result.xoro_sos_returned += records.length;
      result.per_status.push({ status, pages: pageCount, records: records.length, ok: !!r.ok });
      if (!r.ok) {
        result.errors.push(`status=${status}: ${r.body?.error || r.body?.Message || "fetch failed"}`);
        continue;
      }
      allRaw.push(...records);
    }
    if (allRaw.length === 0 && result.errors.length > 0) {
      return res.status(502).json({ ...result, error: "All status fetches failed" });
    }

    // 2. Flatten + dedup by SoNumber. Active statuses come first so a still-
    //    active SO wins over a stale terminal sighting of the same order.
    const bySo = new Map();
    for (const raw of allRaw) {
      const flat = flattenXoroSo(raw);
      const soNumber = String(flat.SoNumber ?? "").trim();
      if (!soNumber) { result.skipped_no_so_number++; continue; }
      if (!bySo.has(soNumber)) bySo.set(soNumber, flat);
    }
    result.sos_unique_after_dedup = bySo.size;
    if (bySo.size === 0) return res.status(200).json(result);

    // 3. Build upsert rows.
    const now = new Date().toISOString();
    const rows = [];
    for (const [soNumber, flat] of bySo) {
      rows.push({
        so_number: soNumber,
        customer: flat.CustomerName ?? "",
        date_order: toIsoDate(flat.DateOrder),
        date_shipped: toIsoDate(flat.DateToBeShipped),
        date_cancel: toIsoDate(flat.DateToBeCancelled),
        status: flat.StatusName ?? "",
        data: flat,
        synced_at: now,
      });
    }

    // 4. Upsert in chunks (Supabase REST body ~1MB).
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await admin
        .from("tanda_sos")
        .upsert(chunk, { onConflict: "so_number", ignoreDuplicates: false });
      if (error) { result.errors.push(`upsert chunk ${i}: ${error.message}`); continue; }
      upserted += chunk.length;
    }
    result.upserted = upserted;

    return res.status(200).json(result);
  } catch (e) {
    console.error(`[tanda/sync-sos-from-xoro ${requestId}] failed:`, e);
    return res.status(500).json({ ...result, error: "Sync failed", message: String(e?.message || e) });
  }
}
