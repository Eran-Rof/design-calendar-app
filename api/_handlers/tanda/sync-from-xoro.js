// POST /api/tanda/sync-from-xoro — server-side Xoro→tanda_pos refresh.
//
// The browser-side useSyncOps.ts has done this work since day one (fan
// out per-status fetches → upsert tanda_pos), but it only runs when
// someone clicks "Sync" in the PO WIP UI. The nightly pipeline needs the
// same refresh without a browser. This endpoint is the missing half of
// the chain:
//
//   Xoro  ──(this endpoint)──▶  tanda_pos  ──(/api/planning/sync-open-pos)──▶  ip_open_purchase_orders
//
// The downstream half already exists in api/_lib/planning-sync.js
// (syncOpenPosFromTandaPos). Nightly script post_purchase_orders.py
// calls both endpoints in sequence.
//
// Active-status scope: Open + Released + Partially Received. Terminal
// statuses (Received/Closed/Cancelled) are deliberately NOT fetched —
// the planning grid only cares about not-yet-received supply, and the
// browser's archive logic only needs to run when the user is looking at
// the UI. For nightly cleanup, syncOpenPosFromTandaPos's qty_open<=0
// filter already drops fully-received POs from ip_open_purchase_orders.
//
// Buyer_po preservation: when a user has set a custom BuyerPo in the UI
// (stored in tanda_pos.buyer_po), we preserve it across nightly syncs.
// Mirrors the existing useSyncOps.ts behaviour at line 297-307.
//
// Auth: bearer DESIGN_CALENDAR_API_TOKEN (same gate post_to_ats.py /
// post_master_data.py / post_invoice_detail.py use).

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll } from "../../_lib/xoro-client.js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

export const config = { maxDuration: 300 };

const PO_PATH = "purchaseorder/getpurchaseorder";
const ACTIVE_STATUSES = ["Open", "Released", "Partially Received"];

// Flatten Xoro's wrapped PO shape ({ poHeader: {...}, poLines: [...] })
// into the flat shape the browser-side useSyncOps writes to tanda_pos
// (PoNumber, VendorName, ... at the top level + Items: [...] for lines).
// This MUST mirror src/utils/tandaTypes.ts::mapXoroRaw() — same lookup
// keys, same fallback chain — so tanda_pos rows written by the nightly
// agent are indistinguishable from rows written by the PO WIP UI.
//
// Why flatten here, not let downstream do it: api/_lib/planning-sync.js
// (syncOpenPosFromTandaPos) reads po.PoLineArr / po.Items only — it
// won't recognize Xoro's poLines array. Writing the wrapped shape would
// silently drop every PO's line items at promote time.
function flattenXoroPo(raw) {
  const h = raw?.poHeader ?? raw ?? {};
  const lines = Array.isArray(raw?.poLines) ? raw.poLines
              : Array.isArray(raw?.PoLineArr) ? raw.PoLineArr
              : Array.isArray(raw?.Items) ? raw.Items
              : [];
  return {
    PoNumber:              h.OrderNumber ?? h.PoNumber ?? "",
    VendorName:            h.VendorName ?? "",
    DateOrder:             h.DateOrder ?? "",
    DateExpectedDelivery:  h.DateExpectedDelivery ?? "",
    VendorReqDate:         h.VendorReqDate ?? "",
    StatusName:            h.StatusName ?? "",
    CurrencyCode:          h.CurrencyCode ?? "USD",
    Memo:                  h.Memo ?? "",
    Tags:                  h.Tags ?? "",
    PaymentTermsName:      h.PaymentTermsName ?? "",
    ShipMethodName:        h.ShipMethodName ?? "",
    CarrierName:           h.CarrierName ?? "",
    BuyerName:             h.BuyerName ?? "",
    BuyerPo:               h.ReferenceNumber ?? h.RefNumber ?? h.BuyerOrderNumber ?? h.BuyerPo ?? "",
    BrandName:             h.BrandName ?? h.Brand ?? "",
    TotalAmount:           h.TotalAmount ?? 0,
    Items: lines.map((l) => ({
      ItemNumber:           l.PoItemNumber ?? l.ItemNumber ?? "",
      Description:          l.Description ?? l.Title ?? "",
      QtyOrder:             l.QtyOrder ?? 0,
      QtyReceived:          l.QtyReceived ?? 0,
      QtyRemaining:         l.QtyRemaining ?? ((l.QtyOrder ?? 0) - (l.QtyReceived ?? 0)),
      UnitPrice:            l.UnitPrice ?? l.EffectiveUnitPrice ?? 0,
      StatusName:           l.StatusName ?? l.Status ?? l.LineStatusName ?? "",
      DateExpectedDelivery: l.DateExpectedDelivery ?? l.DeliveryDate ?? l.DateDelivery ?? l.DateExpected ?? "",
    })),
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

  // Match the cadence the other Design Calendar scriptable endpoints use
  // (master/sync = 12/hr, sales/sync-invoices = 30/hr). PO sync is a
  // single nightly call; 12/hr is plenty and keeps the budget tight in
  // case a flaky pipeline retries hard.
  const tokenTail = (req.headers.authorization || "").slice(-8) || "anon";
  const rl = rateLimit(`tanda-sync-from-xoro:${tokenTail}`, { limit: 12, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const requestId = randomUUID();
  const result = {
    request_id: requestId,
    statuses_fetched: ACTIVE_STATUSES,
    xoro_pages_walked: 0,
    xoro_pos_returned: 0,
    pos_unique_after_dedup: 0,
    upserted: 0,
    skipped_no_po_number: 0,
    buyer_po_preserved: 0,
    per_status: [],
    errors: [],
  };

  try {
    // 1. Fan out Xoro fetches sequentially. Parallel fan-out trips Xoro
    //    rate limits (the browser uses CONCURRENCY=2 + 600ms stagger;
    //    server-side we have time, so go strictly sequential).
    const allRaw = [];
    for (const status of ACTIVE_STATUSES) {
      const r = await fetchXoroAll({
        path: PO_PATH,
        params: { per_page: "200", status },
        // module=undefined → default "PO To ASN Workflow" creds, which
        // is what xoro-proxy.js uses for purchaseorder/getpurchaseorder.
      });
      const pageCount = Array.isArray(r.body?._pageCounts) ? r.body._pageCounts.length : 0;
      const records = Array.isArray(r.body?.Data) ? r.body.Data : [];
      result.xoro_pages_walked += pageCount;
      result.xoro_pos_returned += records.length;
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

    // 2. Flatten Xoro's wrapped shape (poHeader + poLines) into the flat
    //    PO shape useSyncOps writes. Then dedup by PoNumber. A PO that
    //    flips status mid-walk can appear under more than one status
    //    bucket; keep the first occurrence (Open before Released before
    //    Partially Received).
    const byPo = new Map();
    for (const raw of allRaw) {
      const flat = flattenXoroPo(raw);
      const poNumber = String(flat.PoNumber ?? "").trim();
      if (!poNumber) { result.skipped_no_po_number++; continue; }
      if (!byPo.has(poNumber)) byPo.set(poNumber, flat);
    }
    result.pos_unique_after_dedup = byPo.size;
    if (byPo.size === 0) {
      return res.status(200).json(result);
    }

    // 3. Pull existing tanda_pos rows so we can preserve user-set
    //    buyer_po overrides. Only pulling po_number + buyer_po keeps
    //    the response small (~50KB for 2,500 rows).
    const existingBuyerPo = new Map();
    {
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await admin
          .from("tanda_pos")
          .select("po_number, buyer_po")
          .order("po_number", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) {
          result.errors.push(`tanda_pos lookup: ${error.message}`);
          break;
        }
        if (!data || data.length === 0) break;
        for (const r of data) {
          if (r.buyer_po) existingBuyerPo.set(r.po_number, r.buyer_po);
        }
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // 4. Build upsert rows. Matches useSyncOps.ts:295-312 exactly so
    //    nightly + browser writes converge on the same shape and the
    //    UI's PoNumber → row lookup keeps working.
    const now = new Date().toISOString();
    const rows = [];
    for (const [poNumber, flat] of byPo) {
      // flat is already in the canonical shape (PoNumber/Items/etc.).
      // Preserve user-set buyer_po overrides — clearing the override
      // re-opens the field to Xoro's value.
      const userBuyerPo = existingBuyerPo.get(poNumber) || "";
      const buyerPo = userBuyerPo || flat.BuyerPo || "";
      if (userBuyerPo) result.buyer_po_preserved++;
      rows.push({
        po_number: poNumber,
        vendor: flat.VendorName ?? "",
        date_order: flat.DateOrder || null,
        date_expected: flat.DateExpectedDelivery || null,
        status: flat.StatusName ?? "",
        buyer_po: buyerPo || null,
        data: { ...flat, BuyerPo: buyerPo },
        synced_at: now,
      });
    }

    // 5. Upsert in chunks (Supabase REST tops out around 1MB body).
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await admin
        .from("tanda_pos")
        .upsert(chunk, { onConflict: "po_number", ignoreDuplicates: false });
      if (error) {
        result.errors.push(`upsert chunk ${i}: ${error.message}`);
        continue;
      }
      result.upserted += chunk.length;
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error(`[tanda/sync-from-xoro ${requestId}] failed:`, e);
    return res.status(500).json({ ...result, error: "Sync failed", message: String(e?.message || e) });
  }
}
