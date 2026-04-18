// api/xoro-receipts-sync.js — Vercel Node.js Serverless Function
//
// Phase 2.3 finisher — pulls item receipts from Xoro and upserts into
// receipts + receipt_line_items.
//
// STATUS: path TBD. The Xoro "Item Receipt" endpoint path is not
// discoverable by trial; probed 27 candidates, all returned 500
// "An error has occurred" or timed out. Need the exact URL from
// Xoro support / their in-app API docs / network tab on the Item
// Receipts screen. Once known, set RECEIPT_PATH and this endpoint
// works.
//
// Override at call time with ?path=xerp/module/action to try a specific
// path without redeploying.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 120 };

const RECEIPT_PATH = "itemreceipt/getitemreceipt"; // TODO replace with real path

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
  const path = url.searchParams.get("path") || RECEIPT_PATH;
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const poNumber = url.searchParams.get("po_number") || "";

  const xoroParams = new URLSearchParams();
  xoroParams.set("per_page", "200");
  if (dateFrom) xoroParams.set("created_at_min", new Date(dateFrom).toISOString());
  if (dateTo)   xoroParams.set("created_at_max", new Date(dateTo + "T23:59:59").toISOString());
  if (poNumber) xoroParams.set("po_number", poNumber);

  const creds = Buffer.from(`${XORO_KEY}:${XORO_SECRET}`).toString("base64");
  const xoroUrl = `https://res.xorosoft.io/api/xerp/${path}?${xoroParams.toString()}`;

  let xoroBody = null;
  let xoroStatus = 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const r = await fetch(xoroUrl, {
      headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    xoroStatus = r.status;
    const text = await r.text();
    try { xoroBody = JSON.parse(text); } catch { xoroBody = { raw: text.slice(0, 500) }; }
  } catch (err) {
    return res.status(500).json({ error: "Xoro fetch failed: " + (err?.message || err), path });
  }

  if (xoroStatus < 200 || xoroStatus >= 300 || !xoroBody?.Result) {
    return res.status(200).json({
      error: "Xoro returned an error — probably the wrong path or missing required params",
      xoro_status: xoroStatus,
      xoro_message: xoroBody?.Message || null,
      path,
      debug: xoroBody,
    });
  }

  const receipts = Array.isArray(xoroBody.Data) ? xoroBody.Data : [];
  const result = {
    path,
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

      const lines = Array.isArray(rc.Items) ? rc.Items
                 : Array.isArray(rc.LineItems) ? rc.LineItems
                 : Array.isArray(rc.Lines) ? rc.Lines
                 : [];
      if (lines.length === 0) { result.skipped_no_line_items++; result.upserted++; continue; }

      await admin.from("receipt_line_items").delete().eq("receipt_id", rcRow.id);

      const { data: poLines } = await admin
        .from("po_line_items")
        .select("id, item_number")
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
