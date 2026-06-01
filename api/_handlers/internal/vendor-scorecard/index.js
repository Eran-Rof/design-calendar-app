// api/internal/vendor-scorecard
//
// Chunk E — Vendor drill-through scorecard (operator item 1; purchase/delivery oriented).
//
// GET ?vendor_id=<uuid>[&from=YYYY-MM-DD&to=YYYY-MM-DD&status=<po_status>]
//
// Returns:
//   {
//     header:  { vendor_id, vendor_name, vendor_code, status, country },
//     metrics: { avg_lead_time_days, pct_ontime_promised, pct_ontime_required,
//                po_count, received_po_count, ap_balance_cents },
//     invoices:[...],            // AP invoices (table `invoices`, vendor_id)
//     purchase_orders:[...],     // tanda_pos for this vendor (all statuses)
//     notes: { ... }
//   }
//
// ── DATA SOURCES (one comment per metric) ────────────────────────────────────
//  • avg_lead_time_days   = avg(receipt_date − date_order) across this vendor's
//                          POs that have at least one tanda_po_receipts row.
//                          tanda_pos.date_order = PO order/creation date;
//                          tanda_po_receipts.receipt_date = actual receipt.
//                          NULL → "—" when no received POs.
//  • pct_ontime_promised  = % of received POs whose EARLIEST receipt_date ≤
//                          tanda_pos.date_expected (the PO's promised/expected
//                          delivery date). NULL → "—" when no received POs with a
//                          date_expected.
//  • pct_ontime_required  = THE SCHEMA HAS NO SEPARATE required/requested-delivery
//                          date on tanda_pos distinct from date_expected (only
//                          `date_expected` + a free-text `date_expected_delivery`).
//                          So a distinct "required vs actual" on-time % cannot be
//                          computed honestly → returned as null with a "needs X" note.
//  • ap_balance_cents     = Σ(total_amount_cents − paid_amount_cents) over non-void
//                          AP invoices (table `invoices`) for this vendor.
//  • AP invoices tab      = `invoices` table filtered by vendor_id.
//  • POs tab              = tanda_pos filtered by vendor_id (all statuses).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntity(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function isDate(s) { return typeof s === "string" && ISO_DATE_RE.test(s); }

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntity(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const vendorId = (url.searchParams.get("vendor_id") || "").trim();
  if (!UUID_RE.test(vendorId)) return res.status(400).json({ error: "vendor_id (uuid) is required" });
  const from = (url.searchParams.get("from") || "").trim();
  const to   = (url.searchParams.get("to") || "").trim();
  const statusFilter = (url.searchParams.get("status") || "").trim();
  if (from && !ISO_DATE_RE.test(from)) return res.status(400).json({ error: "from must be YYYY-MM-DD" });
  if (to && !ISO_DATE_RE.test(to)) return res.status(400).json({ error: "to must be YYYY-MM-DD" });

  try {
    // ── Header: vendor ───────────────────────────────────────────────────────
    const { data: vendor } = await admin
      .from("vendors")
      .select("id, name, code, status, country")
      .eq("id", vendorId)
      .maybeSingle();
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    // ── Purchase orders (tanda_pos) ──────────────────────────────────────────
    let poQuery = admin
      .from("tanda_pos")
      .select("id, po_number, buyer_po, vendor, status, procurement_status, date_order, date_expected, date_expected_delivery, expected_landed_cost_cents, actual_landed_cost_cents")
      .eq("vendor_id", vendorId)
      .order("date_order", { ascending: false, nullsFirst: false })
      .limit(2000);
    if (statusFilter) poQuery = poQuery.eq("status", statusFilter);
    if (from) poQuery = poQuery.gte("date_order", from);
    if (to)   poQuery = poQuery.lte("date_order", to);
    const { data: poAll } = await poQuery;
    const purchaseOrders = poAll || [];

    // ── Receipts for these POs ───────────────────────────────────────────────
    const poIds = purchaseOrders.map((p) => p.id);
    const earliestReceiptByPo = new Map();
    if (poIds.length) {
      const { data: rcpts } = await admin
        .from("tanda_po_receipts")
        .select("tanda_po_id, receipt_date")
        .in("tanda_po_id", poIds.slice(0, 1000));
      for (const r of rcpts || []) {
        if (!r.receipt_date) continue;
        const cur = earliestReceiptByPo.get(r.tanda_po_id);
        if (!cur || r.receipt_date < cur) earliestReceiptByPo.set(r.tanda_po_id, r.receipt_date);
      }
    }

    // ── Lead time + on-time-promised ─────────────────────────────────────────
    const leadDiffs = [];
    let promisedEligible = 0, promisedOnTime = 0;
    for (const po of purchaseOrders) {
      const recv = earliestReceiptByPo.get(po.id);
      if (!recv) continue;
      if (isDate(po.date_order)) {
        const days = (Date.parse(recv) - Date.parse(po.date_order)) / 86400000;
        if (Number.isFinite(days)) leadDiffs.push(days);
      }
      if (isDate(po.date_expected)) {
        promisedEligible += 1;
        if (recv <= po.date_expected) promisedOnTime += 1;
      }
    }
    const avgLeadTimeDays = leadDiffs.length
      ? Math.round((leadDiffs.reduce((s, d) => s + d, 0) / leadDiffs.length) * 10) / 10
      : null;
    const pctOnTimePromised = promisedEligible ? Math.round((promisedOnTime / promisedEligible) * 1000) / 10 : null;

    // pct_ontime_required: no distinct required-delivery date in tanda_pos → null.
    const pctOnTimeRequired = null;

    // ── AP invoices (table `invoices`) ───────────────────────────────────────
    let invQuery = admin
      .from("invoices")
      .select("id, invoice_number, invoice_kind, gl_status, posting_date, due_date, description, total_amount_cents, paid_amount_cents, source")
      .eq("entity_id", entityId)
      .eq("vendor_id", vendorId)
      .order("posting_date", { ascending: false })
      .limit(2000);
    if (from) invQuery = invQuery.gte("posting_date", from);
    if (to)   invQuery = invQuery.lte("posting_date", to);
    const { data: invAll } = await invQuery;
    const invoices = invAll || [];
    let apBalanceCents = 0;
    for (const inv of invoices) {
      if (inv.gl_status === "void") continue;
      apBalanceCents += n(inv.total_amount_cents) - n(inv.paid_amount_cents);
    }

    return res.status(200).json({
      header: {
        vendor_id: vendor.id,
        vendor_name: vendor.name,
        vendor_code: vendor.code,
        status: vendor.status,
        country: vendor.country,
      },
      metrics: {
        avg_lead_time_days: avgLeadTimeDays,
        pct_ontime_promised: pctOnTimePromised,
        pct_ontime_required: pctOnTimeRequired,
        po_count: purchaseOrders.length,
        received_po_count: earliestReceiptByPo.size,
        ap_balance_cents: apBalanceCents,
      },
      invoices,
      purchase_orders: purchaseOrders,
      notes: {
        avg_lead_time_days: avgLeadTimeDays == null ? "needs POs with a receipt and a date_order" : "avg(earliest receipt_date − date_order) over received POs.",
        pct_ontime_promised: pctOnTimePromised == null ? "needs received POs that carry date_expected" : "% of received POs whose earliest receipt ≤ date_expected.",
        pct_ontime_required: "needs a distinct required/requested-delivery date on tanda_pos (only date_expected exists) — not computable.",
        ap_balance_cents: "Σ(total − paid) over non-void AP invoices (table `invoices`) for this vendor.",
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
