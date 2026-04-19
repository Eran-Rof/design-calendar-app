// api/vendor/reports/summary.js
//
// GET — vendor self-service YTD summary.
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  — defaults to Jan 1 of current year → today
//
// Response:
//   {
//     period: { from, to },
//     pos_this_year, pos_by_status: { issued, acknowledged, fulfilled, closed },
//     invoices_this_year, invoices_by_status: { submitted, under_review, approved, paid },
//     total_invoiced_ytd, total_paid_ytd,
//     avg_payment_days,             // days from approved -> paid
//     on_time_delivery_pct,         // mirrors vendor_kpi_live logic
//     invoice_accuracy_pct
//   }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { vendor_id: vu.vendor_id } : null;
  } catch {
    return null;
  }
}

function bucketPo(po, ackSet) {
  const statusName = ((po.data && po.data.StatusName) || "").toLowerCase();
  if (statusName.includes("closed")) return "closed";
  if (statusName.includes("received") || statusName.includes("shipped") || statusName.includes("fulfilled")) return "fulfilled";
  if (ackSet.has(po.po_number)) return "acknowledged";
  return "issued";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const year = new Date().getFullYear();
  const fromDate = url.searchParams.get("from") || `${year}-01-01`;
  const toDate = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
  const fromMs = new Date(fromDate + "T00:00:00").getTime();
  const toMs = new Date(toDate + "T23:59:59").getTime();

  const [poRes, ackRes, invRes, matchRes] = await Promise.all([
    admin.from("tanda_pos")
      .select("uuid_id, po_number, data, date_expected_delivery")
      .eq("vendor_id", caller.vendor_id),
    admin.from("po_acknowledgments").select("po_number, acknowledged_at"),
    admin.from("invoices")
      .select("id, total, status, submitted_at, approved_at, paid_at")
      .eq("vendor_id", caller.vendor_id)
      .gte("submitted_at", fromDate + "T00:00:00")
      .lte("submitted_at", toDate + "T23:59:59"),
    admin.from("three_way_match_view").select("line_status").eq("vendor_id", caller.vendor_id),
  ]);

  if (poRes.error)    return res.status(500).json({ error: poRes.error.message });
  if (ackRes.error)   return res.status(500).json({ error: ackRes.error.message });
  if (invRes.error)   return res.status(500).json({ error: invRes.error.message });
  if (matchRes.error) return res.status(500).json({ error: matchRes.error.message });

  const pos = poRes.data || [];
  const invoices = invRes.data || [];
  const matchLines = matchRes.data || [];
  const ackSet = new Set((ackRes.data || []).map((a) => a.po_number));

  const posInRange = pos.filter((p) => {
    const d = p.data?.DateOrder ? new Date(p.data.DateOrder).getTime() : 0;
    return d >= fromMs && d <= toMs && !p.data?._archived;
  });

  const pos_by_status = { issued: 0, acknowledged: 0, fulfilled: 0, closed: 0 };
  let onTimeCount = 0;
  const nowMs = Date.now();
  for (const p of posInRange) {
    pos_by_status[bucketPo(p, ackSet)]++;
    const ddp = p.date_expected_delivery || p.data?.DateExpectedDelivery;
    if (!ddp || new Date(ddp).getTime() >= nowMs) onTimeCount++;
  }

  const invoices_by_status = { submitted: 0, under_review: 0, approved: 0, paid: 0 };
  let totalInvoicedYTD = 0;
  let totalPaidYTD = 0;
  const paymentDays = [];
  for (const i of invoices) {
    if (Object.prototype.hasOwnProperty.call(invoices_by_status, i.status)) invoices_by_status[i.status]++;
    if (i.status === "approved" || i.status === "paid") totalInvoicedYTD += Number(i.total) || 0;
    if (i.status === "paid") {
      totalPaidYTD += Number(i.total) || 0;
      if (i.paid_at && i.approved_at) {
        const d = (new Date(i.paid_at).getTime() - new Date(i.approved_at).getTime()) / 86_400_000;
        if (d >= 0) paymentDays.push(d);
      }
    }
  }
  const avgPaymentDays = paymentDays.length
    ? paymentDays.reduce((a, b) => a + b, 0) / paymentDays.length
    : null;

  const onTimePct = posInRange.length > 0 ? (onTimeCount / posInRange.length) * 100 : null;
  const totalLines = matchLines.length;
  const matchedLines = matchLines.filter((l) => l.line_status === "matched").length;
  const accuracyPct = totalLines > 0 ? (matchedLines / totalLines) * 100 : null;

  return res.status(200).json({
    period: { from: fromDate, to: toDate },
    pos_this_year: posInRange.length,
    pos_by_status,
    invoices_this_year: invoices.length,
    invoices_by_status,
    total_invoiced_ytd: Math.round(totalInvoicedYTD * 100) / 100,
    total_paid_ytd: Math.round(totalPaidYTD * 100) / 100,
    avg_payment_days: avgPaymentDays != null ? Math.round(avgPaymentDays * 10) / 10 : null,
    on_time_delivery_pct: onTimePct != null ? Math.round(onTimePct * 10) / 10 : null,
    invoice_accuracy_pct: accuracyPct != null ? Math.round(accuracyPct * 10) / 10 : null,
  });
}
