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

const RECEIPT_PATH = "itemreceipt/getitemreceipt"; // TODO: confirm

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
  const xoroUrl = `https://res.xorosoft.io/api/xerp/${RECEIPT_PATH}?${xoroParams.toString()}`;

  let xoroBody = null;
  let xoroStatus = 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(xoroUrl, {
      headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    xoroStatus = r.status;
    const text = await r.text();
    try { xoroBody = JSON.parse(text); } catch { xoroBody = { raw: text.slice(0, 1000) }; }
  } catch (err) {
    return res.status(500).json({ error: "Xoro fetch failed: " + (err?.message || err), path: RECEIPT_PATH });
  }

  if (xoroStatus < 200 || xoroStatus >= 300 || !xoroBody?.Result) {
    return res.status(200).json({
      error: "Xoro returned an error or empty dataset",
      xoro_status: xoroStatus,
      xoro_message: xoroBody?.Message || null,
      path: RECEIPT_PATH,
      debug: xoroBody,
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
