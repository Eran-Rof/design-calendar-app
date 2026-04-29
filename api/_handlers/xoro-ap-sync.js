// api/xoro-ap-sync.js — Vercel Node.js Serverless Function
//
// Phase 2.7 — pulls bills (AP invoices) from Xoro and updates our
// invoices table with payment status. Called on-demand from the internal
// TandA UI; no cron/polling.
//
// Matching strategy:
//   1. Prefer exact (vendor_id, invoice_number = Xoro BillNumber) match
//   2. Fall back to (vendor_id, po_number) match — if there's only one
//      open invoice against that PO, attach the Xoro bill to it
//
// If Xoro reports the bill as paid (PaidAmount >= TotalAmount), we mark
// our invoice status='paid' and set paid_at + payment_reference. If it's
// open/partially paid, we set xoro_ap_id but leave status.
//
// The Xoro endpoint path here is a guess based on the xoro API naming
// convention (purchaseorder/getpurchaseorder). If it 404s, tweak BILL_PATH.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 120 };

const BILL_PATH = "bill/getbill"; // TODO: confirm when we see a live response

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

  // Build Xoro call
  const xoroParams = new URLSearchParams();
  xoroParams.set("per_page", "200");
  if (dateFrom) xoroParams.set("created_at_min", new Date(dateFrom).toISOString());
  if (dateTo)   xoroParams.set("created_at_max", new Date(dateTo + "T23:59:59").toISOString());
  if (poNumber) xoroParams.set("po_number", poNumber);

  const creds = Buffer.from(`${XORO_KEY}:${XORO_SECRET}`).toString("base64");
  const xoroUrl = `https://res.xorosoft.io/api/xerp/${BILL_PATH}?${xoroParams.toString()}`;

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
    return res.status(500).json({ error: "Xoro fetch failed: " + (err?.message || err), path: BILL_PATH });
  }

  if (xoroStatus < 200 || xoroStatus >= 300 || !xoroBody?.Result) {
    return res.status(200).json({
      error: "Xoro returned an error or empty dataset",
      xoro_status: xoroStatus,
      xoro_message: xoroBody?.Message || null,
      path: BILL_PATH,
      debug: xoroBody,
    });
  }

  const bills = Array.isArray(xoroBody.Data) ? xoroBody.Data : [];
  const result = {
    path: BILL_PATH,
    xoro_bills_fetched: bills.length,
    matched_by_invoice_number: 0,
    matched_by_po_number: 0,
    marked_paid: 0,
    unmatched: 0,
    errors: [],
  };

  // Vendor name → id lookup
  const { data: vendorRows } = await admin.from("vendors").select("id, name");
  const vendorByName = new Map();
  for (const v of vendorRows ?? []) vendorByName.set((v.name || "").toLowerCase(), v.id);

  for (const bill of bills) {
    try {
      const vendorName = (bill.VendorName || bill.Vendor || "").toLowerCase();
      const vendorId = vendorByName.get(vendorName);
      const billNumber = bill.BillNumber || bill.ThirdPartyRefNo || bill.Number;
      const billPONumber = bill.PoNumber || bill.PurchaseOrderNumber;
      // Strip thousand-separators / currency glyphs before Number(),
      // otherwise "1,234.56" becomes NaN and we silently treat the bill
      // as $0. Use 4-decimal cents math for the paid-vs-total
      // comparison so float drift doesn't accidentally mark a bill paid.
      const cleanMoney = (v) => {
        if (v == null) return 0;
        const s = String(v).replace(/[$,\s]/g, "");
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : 0;
      };
      const total = cleanMoney(bill.Amount ?? bill.TotalAmount);
      const paid  = cleanMoney(bill.PaidAmount ?? bill.AmountPaid);
      const totalCents = Math.round(total * 10000);
      const paidCents  = Math.round(paid * 10000);
      // 1c tolerance preserved (100 in 4-decimal-precision integers).
      const isPaid = totalCents > 0 && paidCents >= totalCents - 100;
      const paidAt = isPaid ? (bill.PaidDate || bill.LastPaymentDate || new Date().toISOString()) : null;
      const xoroApId = String(bill.Id ?? bill.BillId ?? bill.TxnId ?? "");

      if (!vendorId || !billNumber) { result.unmatched++; continue; }

      // Try exact match on invoice_number
      const { data: exact } = await admin
        .from("invoices")
        .select("id, status")
        .eq("vendor_id", vendorId)
        .eq("invoice_number", billNumber)
        .maybeSingle();

      let invoiceId = exact?.id ?? null;
      let matchMode = exact ? "invoice_number" : null;

      if (!invoiceId && billPONumber) {
        // Fall back to PO-level match — only if exactly one open invoice exists
        const { data: poTp } = await admin
          .from("tanda_pos").select("uuid_id").eq("po_number", billPONumber).maybeSingle();
        if (poTp) {
          const { data: candidates } = await admin
            .from("invoices")
            .select("id, status")
            .eq("vendor_id", vendorId)
            .eq("po_id", poTp.uuid_id)
            .in("status", ["submitted", "under_review", "approved"]);
          if (candidates && candidates.length === 1) {
            invoiceId = candidates[0].id;
            matchMode = "po_number";
          }
        }
      }

      if (!invoiceId) { result.unmatched++; continue; }

      const updates = {
        xoro_ap_id: xoroApId || null,
        xoro_last_synced_at: new Date().toISOString(),
      };
      if (isPaid) {
        updates.status = "paid";
        updates.paid_at = paidAt;
        updates.payment_reference = bill.PaymentReference || bill.CheckNumber || null;
        updates.payment_method = bill.PaymentMethod || null;
      }

      const { error: upErr } = await admin.from("invoices").update(updates).eq("id", invoiceId);
      if (upErr) { result.errors.push({ bill: billNumber, error: upErr.message }); continue; }

      if (matchMode === "invoice_number") result.matched_by_invoice_number++;
      if (matchMode === "po_number") result.matched_by_po_number++;
      if (isPaid) result.marked_paid++;
    } catch (err) {
      result.errors.push({ bill: bill.BillNumber, error: err?.message || String(err) });
    }
  }

  return res.status(200).json(result);
}
