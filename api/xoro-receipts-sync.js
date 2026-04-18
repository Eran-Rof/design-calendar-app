// api/xoro-receipts-sync.js — Vercel Node.js Serverless Function
//
// Phase 2.3 (finisher) — pulls item receipts from Xoro and upserts into
// our receipts + receipt_line_items. Called on-demand.
//
// Matching strategy:
//   • receipts.xoro_receipt_id (unique) dedupes across runs
//   • receipts.po_id resolved via tanda_pos.po_number -> tanda_pos.uuid_id
//   • receipts.vendor_id inherited from the matched PO
//   • receipt_line_items.po_line_item_id resolved via po_id + item_number
//
// Xoro endpoint path is a guess; tweak RECEIPT_PATH if the first call
// 404s.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 120 };

// We don't know the exact Xoro receipt path yet. Probe several candidates
// based on their naming convention — the first one that returns Result:true
// wins. Override with ?path= in the query to try a specific one.
// "Bill & Item Receipt Management" is the Xoro scope name and bill/getbill
// works, so item-receipt naming likely mirrors it closely. Try a broader set.
const RECEIPT_PATH_CANDIDATES = [
  // bill-prefixed (since the scope groups them)
  "bill/getitemreceipt",
  "bill/getitemreceipts",
  "bills/getitemreceipt",
  "bills/getitemreceipts",
  // plain itemreceipt variants
  "itemreceipt/getitemreceipt",
  "itemreceipts/getitemreceipts",
  "itemreceipt/get",
  "itemreceipt/getall",
  "itemreceipt/getlist",
  "itemreceipts/get",
  // alt module names
  "purchasereceipt/getpurchasereceipt",
  "purchaseorderreceipt/getpurchaseorderreceipt",
  "billreceipt/getbillreceipt",
  "receipt/getreceipt",
  "receipts/getreceipts",
  // receiving / goods receipt
  "receiving/getreceiving",
  "goodsreceipt/getgoodsreceipt",
  "goodsreceiptnote/getgoodsreceiptnote",
  "grn/getgrn",
  // via ASN (receipts often derive from ASN close)
  "asn/getasn",
  "asn/getasns",
  // via PO module
  "purchaseorder/getreceipt",
  "purchaseorder/getreceipts",
  "purchaseorder/getitemreceipt",
  // inventory module
  "inventoryreceipt/getinventoryreceipt",
  "inventory/getitemreceipt",
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const XORO_KEY = process.env.VITE_XORO_API_KEY;
  const XORO_SECRET = process.env.VITE_XORO_API_SECRET;
  if (!SB_URL || !SERVICE_KEY || !XORO_KEY || !XORO_SECRET) {
    return res.status(500).json({
      error: "Server not configured",
      supabase: !!SB_URL, serviceKey: !!SERVICE_KEY, xoro: !!(XORO_KEY && XORO_SECRET),
    });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const poNumber = url.searchParams.get("po_number") || "";

  const xoroParams = new URLSearchParams();
  xoroParams.set("per_page", "200");
  if (dateFrom) xoroParams.set("created_at_min", new Date(dateFrom).toISOString());
  if (dateTo)   xoroParams.set("created_at_max", new Date(dateTo + "T23:59:59").toISOString());
  if (poNumber) xoroParams.set("po_number", poNumber);

  const creds = Buffer.from(`${XORO_KEY}:${XORO_SECRET}`).toString("base64");
  const overridePath = url.searchParams.get("path");
  const pathsToTry = overridePath ? [overridePath] : RECEIPT_PATH_CANDIDATES;
  // If the caller pinned a specific path, give Xoro 60s rather than the
  // 4s probe budget — they're likely retrying a slow endpoint.
  const perRequestTimeoutMs = overridePath ? 60_000 : 4_000;

  let xoroBody = null;
  let xoroStatus = 0;
  let successPath = null;
  const probeResults = [];

  // Respect Xoro's 2 req/sec rate limit (600ms gap). Tight per-request
  // timeout (4s) — invalid paths return 500 nearly instantly; this
  // only budgets 26 * 1s worst case if Xoro responds fast.
  const startedAt = Date.now();
  const budgetMs = 100_000; // leave headroom under the 120s function cap
  for (let i = 0; i < pathsToTry.length; i++) {
    if (Date.now() - startedAt > budgetMs) {
      probeResults.push({ path: pathsToTry[i], status: -1, message: "skipped: budget exhausted" });
      continue;
    }
    const candidate = pathsToTry[i];
    const xoroUrl = `https://res.xorosoft.io/api/xerp/${candidate}?${xoroParams.toString()}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), perRequestTimeoutMs);
      const r = await fetch(xoroUrl, {
        headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const status = r.status;
      const text = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
      probeResults.push({ path: candidate, status, message: parsed?.Message || null });
      if (status === 200 && parsed?.Result) {
        xoroBody = parsed;
        xoroStatus = status;
        successPath = candidate;
        break;
      }
    } catch (err) {
      probeResults.push({ path: candidate, status: 0, message: err?.name === "AbortError" ? `timeout (${Math.round(perRequestTimeoutMs/1000)}s)` : (err?.message || String(err)) });
    }
    // Rate-limit gap (2 req/sec ceiling)
    if (i < pathsToTry.length - 1) await new Promise((r) => setTimeout(r, 550));
  }

  if (!successPath) {
    return res.status(200).json({
      error: "No receipt endpoint returned data. Pick one of the probed paths that looked promising and call again with ?path=<path>",
      probes: probeResults,
    });
  }

  const receipts = Array.isArray(xoroBody.Data) ? xoroBody.Data : [];
  const result = {
    path: RECEIPT_PATH,
    xoro_receipts_fetched: receipts.length,
    upserted: 0,
    skipped_no_po_match: 0,
    skipped_no_line_items: 0,
    errors: [],
  };

  for (const rc of receipts) {
    try {
      const xoroReceiptId = String(rc.Id ?? rc.TxnId ?? rc.ReceiptId ?? rc.ReceiptNumber ?? "");
      const receiptNumber = rc.ReceiptNumber || rc.Number || xoroReceiptId;
      const rcPoNumber = rc.PoNumber || rc.PurchaseOrderNumber || rc.POReference;
      const receivedDate = rc.ReceivedDate || rc.TxnDate || rc.Date || null;
      const warehouse = rc.LocationName || rc.WarehouseName || rc.StoreName || null;
      if (!xoroReceiptId) { result.errors.push({ receipt: receiptNumber, error: "no xoro id" }); continue; }

      // Resolve PO
      let poId = null;
      let vendorId = null;
      if (rcPoNumber) {
        const { data: tp } = await admin
          .from("tanda_pos")
          .select("uuid_id, vendor_id")
          .eq("po_number", rcPoNumber)
          .maybeSingle();
        if (tp) { poId = tp.uuid_id; vendorId = tp.vendor_id; }
      }
      if (!poId) { result.skipped_no_po_match++; continue; }

      // Upsert the receipt
      const { data: rcRow, error: rcErr } = await admin
        .from("receipts")
        .upsert({
          xoro_receipt_id: xoroReceiptId,
          vendor_id: vendorId,
          po_id: poId,
          receipt_number: receiptNumber,
          received_date: receivedDate,
          received_by: rc.ReceivedBy || null,
          warehouse_locode: warehouse,
          status: "received",
          raw_payload: rc,
          xoro_synced_at: new Date().toISOString(),
        }, { onConflict: "xoro_receipt_id" })
        .select("id")
        .single();
      if (rcErr) { result.errors.push({ receipt: receiptNumber, error: rcErr.message }); continue; }

      // Flatten lines
      const lines = Array.isArray(rc.Items) ? rc.Items
                 : Array.isArray(rc.LineItems) ? rc.LineItems
                 : Array.isArray(rc.Lines) ? rc.Lines
                 : [];
      if (lines.length === 0) { result.skipped_no_line_items++; result.upserted++; continue; }

      // Replace line items for this receipt (idempotent on re-sync)
      await admin.from("receipt_line_items").delete().eq("receipt_id", rcRow.id);

      // Lookup po_line_items for this PO for item_number -> id resolution
      const { data: poLines } = await admin
        .from("po_line_items")
        .select("id, item_number, line_index")
        .eq("po_id", poId);
      const poLineByItem = new Map();
      for (const pl of poLines ?? []) {
        if (pl.item_number) poLineByItem.set(pl.item_number, pl.id);
      }

      const lineRows = lines.map((ln, idx) => ({
        receipt_id: rcRow.id,
        po_line_item_id: poLineByItem.get(ln.ItemNumber || ln.Item || null) || null,
        line_index: ln.LineNumber || idx + 1,
        item_number: ln.ItemNumber || ln.Item || null,
        description: ln.Description || null,
        quantity_received: Number(ln.QtyReceived ?? ln.Qty ?? 0),
        condition: null,
        raw_json: ln,
      })).filter((ln) => ln.quantity_received > 0);

      if (lineRows.length) {
        const { error: lnErr } = await admin.from("receipt_line_items").insert(lineRows);
        if (lnErr) { result.errors.push({ receipt: receiptNumber, error: lnErr.message }); continue; }
      }

      result.upserted++;
    } catch (err) {
      result.errors.push({ receipt: rc?.ReceiptNumber, error: err?.message || String(err) });
    }
  }

  return res.status(200).json(result);
}
