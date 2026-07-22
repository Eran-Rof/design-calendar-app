// api/_handlers/xoro-receipts-sync.js — Vercel Node.js Serverless Function
//
// Pulls Item Receipts from Xoro and upserts into receipts +
// receipt_line_items. These are the REAL goods-in records (a physical
// receiving event per document) and carry the true received date — used
// both for 3-way matching (PO ↔ Receipt ↔ Vendor Invoice) and to date the
// planning "Hist Recv" column to when stock actually arrived rather than
// the expected-delivery proxy (see planning-sync.js syncReceiptsFromTandaPos).
//
// Path: bill/getitemreceipt — confirmed 2026-07-21 against production. The
// Item Receipt resource lives nested under the `bill` module because it
// shares the "Bill & Item Receipt Management" Private App scope. It returns
// the SAME envelope shape as bill/getbill: each Data[] record is
//   { billHeader: {...}, billItemLineArr: [...], ... }
// where billHeader.TxnDate/TxnDateString is the real receive date (MM/DD/YYYY),
// billHeader.TxnId is the stable unique id, and each billItemLineArr[] entry
// carries PoNumber / PoId / PoLineId / ItemNumber / Qty (this receipt) /
// PoQtyReceived (cumulative) / Rate / LandedUnitCost / LandedAmount.
//
// Auth: VITE_XORO_BILL_API_KEY/SECRET via module="bill". The ATS App and
// Sales History keys do NOT have receipt scope and will return 500.

import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll } from "../_lib/xoro-client.js";

export const config = { maxDuration: 300 };

const RECEIPT_PATH = "bill/getitemreceipt";

// Xoro emits dates as 'MM/DD/YYYY' or 'MM/DD/YYYY HH:MM:SS'. Convert to an
// ISO 'YYYY-MM-DD' string WITHOUT going through Date() — new Date("11/15/2024")
// parses at LOCAL midnight and toISOString() can then shift the day across the
// UTC boundary on a TZ-ahead host. String-splitting keeps the calendar date
// exactly as Xoro recorded it. Mirrors rest_ap_sync.py:to_iso_date.
function mmddyyyyToIso(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.startsWith("01/01/0001")) return null;
  const day = s.split(" ")[0];
  const parts = day.split("/");
  if (parts.length === 3) {
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (!y || y < 1900 || !m || !d) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // Already ISO?
  if (day.length === 10 && day[4] === "-" && day[7] === "-") return day;
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured", supabase: !!SB_URL, serviceKey: !!SERVICE_KEY });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || RECEIPT_PATH;
  const poNumber = url.searchParams.get("po_number") || "";
  const status = url.searchParams.get("status") || "";
  const pageStart = Math.max(parseInt(url.searchParams.get("page_start") || "1", 10), 1);
  const maxPages = Math.min(parseInt(url.searchParams.get("max_pages") || "50", 10), 200);
  const module = url.searchParams.get("module") || "bill";

  // bill-module endpoints ignore per_page (return a server-fixed page size)
  // and default to the OPEN scope; `status` widens it ('Open' | 'Posted' |
  // 'Reconciled' | 'Paid') the same way bill/getbill does. po_number narrows.
  const params = { per_page: "200" };
  if (status) params.status = status;
  if (poNumber) params.po_number = poNumber;

  const xoro = await fetchXoroAll({ path, params, pageStart, maxPages, module });
  if (!xoro.ok || !xoro.body?.Result) {
    return res.status(200).json({
      error: "Xoro returned an error — check VITE_XORO_BILL_API_KEY/SECRET and path",
      xoro_message: xoro.body?.Message ?? null,
      path,
      debug: xoro.body,
    });
  }

  const receipts = Array.isArray(xoro.body.Data) ? xoro.body.Data : [];
  const result = {
    path,
    page_start: pageStart,
    max_pages: maxPages,
    xoro_receipts_fetched: receipts.length,
    upserted: 0,
    skipped_no_po_match: 0,
    skipped_no_line_items: 0,
    lines_written: 0,
    errors: [],
  };

  for (const rc of receipts) {
    const header = (rc && rc.billHeader) || {};
    try {
      // Stable unique external ref: TxnId (GUID) is best; fall back to the
      // numeric Id / TxnNumber if a record ever lacks it.
      const xoroReceiptId = String(header.TxnId ?? header.Id ?? header.TxnNumber ?? "");
      const receiptNumber = header.BillNumber || (header.TxnNumber != null ? String(header.TxnNumber) : xoroReceiptId);
      const receivedDate = mmddyyyyToIso(header.TxnDate || header.TxnDateString);
      const warehouse = header.StoreName || header.StoreCode || null;
      if (!xoroReceiptId) { result.errors.push({ receipt: receiptNumber, error: "no xoro id" }); continue; }

      // Lines carry their own PoNumber (a receipt is single-PO in practice but
      // the schema allows several). Resolve the PRIMARY po from the header
      // PoNumber, else the first line's PoNumber, to hang receipts.po_id +
      // vendor off. The per-line PoNumber is preserved in raw_json so the
      // planning promote can date each (po, item) exactly.
      const lines = Array.isArray(rc.billItemLineArr) ? rc.billItemLineArr
                 : Array.isArray(rc.Items) ? rc.Items
                 : Array.isArray(rc.LineItems) ? rc.LineItems
                 : [];
      const primaryPo = String(
        header.PoNumber || (lines.find((l) => l && l.PoNumber)?.PoNumber) || ""
      ).trim();

      let poId = null;
      let vendorId = null;
      if (primaryPo) {
        const { data: tp } = await admin
          .from("tanda_pos")
          .select("uuid_id, vendor_id")
          .eq("po_number", primaryPo)
          .maybeSingle();
        if (tp) { poId = tp.uuid_id; vendorId = tp.vendor_id; }
      }
      // We still record receipts even when the PO isn't in tanda_pos yet
      // (po_id nullable) — the real date is useful regardless. Count the miss.
      if (!poId) result.skipped_no_po_match++;

      const { data: rcRow, error: rcErr } = await admin
        .from("receipts")
        .upsert({
          xoro_receipt_id: xoroReceiptId,
          vendor_id: vendorId,
          po_id: poId,
          receipt_number: receiptNumber,
          received_date: receivedDate,
          received_by: header.StoreCode || null,
          warehouse_locode: warehouse,
          status: "received",
          raw_payload: rc,
          xoro_synced_at: new Date().toISOString(),
        }, { onConflict: "xoro_receipt_id" })
        .select("id")
        .single();
      if (rcErr) { result.errors.push({ receipt: receiptNumber, error: rcErr.message }); continue; }

      if (lines.length === 0) { result.skipped_no_line_items++; result.upserted++; continue; }

      // Rewrite this receipt's lines idempotently.
      await admin.from("receipt_line_items").delete().eq("receipt_id", rcRow.id);

      // Best-effort link to a native po_line_items row (SET NULL when the PO
      // lives only in the tanda_pos mirror, which is the common case).
      const poLineByItem = new Map();
      if (poId) {
        const { data: poLines } = await admin
          .from("po_line_items")
          .select("id, item_number")
          .eq("po_id", poId);
        for (const pl of poLines ?? []) {
          if (pl.item_number) poLineByItem.set(pl.item_number, pl.id);
        }
      }

      const lineRows = lines.map((ln, idx) => ({
        receipt_id: rcRow.id,
        po_line_item_id: poLineByItem.get(ln.ItemNumber || ln.Item || null) || null,
        line_index: Number(ln.LineSeq ?? ln.LineNumber ?? idx + 1),
        item_number: ln.ItemNumber || ln.Item || null,
        description: ln.Description || ln.Title || null,
        quantity_received: Number(ln.Qty ?? ln.QtyReceived ?? 0),
        condition: null,
        // raw_json retains PoNumber / PoLineId / PoQtyReceived / landed cost
        // — the planning promote reads PoNumber from here.
        raw_json: ln,
      })).filter((ln) => ln.quantity_received > 0 && ln.item_number);

      // De-dupe line_index within a receipt (uq_receipt_line_items_line) —
      // reindex sequentially so two lines never collide on (receipt_id, idx).
      lineRows.forEach((r, i) => { r.line_index = i + 1; });

      if (lineRows.length) {
        const { error: lnErr } = await admin.from("receipt_line_items").insert(lineRows);
        if (lnErr) { result.errors.push({ receipt: receiptNumber, error: lnErr.message }); continue; }
        result.lines_written += lineRows.length;
      }

      result.upserted++;
    } catch (err) {
      result.errors.push({ receipt: header?.BillNumber ?? header?.TxnNumber, error: err?.message || String(err) });
    }
  }

  return res.status(200).json(result);
}
