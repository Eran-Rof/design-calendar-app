// api/internal/inventory-purchased-detail
//
// Drill-down for the Inventory Snapshot "Purchased" cell. For one style (+ date
// range) returns per-colour totals + grand total + the purchase list the popup
// shows. TWO sources (operator model: historical from Xoro, live from Tangerine):
//   • Tangerine AP vendor bills (invoices + invoice_line_items) — full detail:
//     vendor, qty, unit price, bill Ref# (clickable → bill popup), bill date,
//     type. Date-filtered on the bill's invoice_date.
//   • Xoro receipt mirror (ip_receipts_history) — historical qty + receipt date
//     + vendor + receipt number (NOT clickable; the feed carries no unit price /
//     bill — that enrichment needs a Xoro REST sync, tracked separately).
//
// GET ?style_id=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
//   → { color_totals:[{ color, qty }], grand_total,
//       rows:[{ color, vendor, qty, unit_price, ref, bill_id, receipt_type,
//               receipt_date, bill_date }] }

import { createClient } from "@supabase/supabase-js";
import { isPpkStyle, ppkUnitsPerPackByStyle } from "../../_lib/styleMatrix.js";

export const config = { maxDuration: 30 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK = 100;
const AP_BILL_KINDS = ["vendor_bill", "vendor_credit_memo"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function chunks(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
async function fetchChunked(ids, fn) { const rows = []; for (const s of chunks(ids, CHUNK)) { const { data, error } = await fn(s); if (error) throw new Error(error.message); if (data) rows.push(...data); } return rows; }

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, "http://x");
  const styleId = String(url.searchParams.get("style_id") || "");
  if (!UUID_RE.test(styleId)) return res.status(400).json({ error: "style_id (uuid) required" });
  const from = DATE_RE.test(String(url.searchParams.get("from") || "")) ? String(url.searchParams.get("from")) : null;
  const to = DATE_RE.test(String(url.searchParams.get("to") || "")) ? String(url.searchParams.get("to")) : null;
  // Explode PPK: when on AND this style is a PPK, purchased quantities (recorded
  // at pack grain) are multiplied by the style's units-per-pack; unit_price is
  // divided by the same so the line amount stays correct after explosion.
  const explodePpk = String(url.searchParams.get("explode_ppk") || "") === "true";

  try {
    const items = await fetchChunked([styleId], (ids) => admin.from("ip_item_master").select("id, color, style_code, size, sku_code").in("style_id", ids));
    const colorByItem = new Map(items.map((i) => [i.id, i.color ?? null]));
    const itemIds = items.map((i) => i.id);
    if (itemIds.length === 0) return res.status(200).json({ color_totals: [], grand_total: 0, rows: [] });

    // Pack ratio for this style (1 = no explosion). PRIMARY = the SKU size token
    // ("PPK24" → 24); prepack_matrices master is only a fallback.
    let packRatio = 1;
    if (explodePpk) {
      const ppkCode = items.map((i) => i.style_code).find((c) => c && isPpkStyle(c));
      if (ppkCode) {
        let r = 0;
        for (const it of items) {
          const m = /PPK\s*(\d+)/i.exec(String(it.size || "")) || /PPK\s*(\d+)/i.exec(String(it.sku_code || ""));
          if (m) { r = parseInt(m[1], 10); break; }
        }
        if (!(r > 0)) {
          const { data: ent } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
          const u = await ppkUnitsPerPackByStyle(admin, ent?.id || null, [ppkCode]);
          r = u.get(String(ppkCode).toLowerCase()) || 0;
        }
        if (r > 0) packRatio = r;
      }
    }

    const rows = [];

    // ── Tangerine AP vendor bills ─────────────────────────────────────────────
    const liRows = await fetchChunked(itemIds, (ids) =>
      admin.from("invoice_line_items").select("invoice_id, inventory_item_id, quantity, unit_cost_cents, unit_price, po_number").in("inventory_item_id", ids));
    const invIds = [...new Set(liRows.map((l) => l.invoice_id).filter(Boolean))];
    const invById = new Map();
    if (invIds.length) {
      const invs = await fetchChunked(invIds, (ids) => {
        let q = admin.from("invoices").select("id, invoice_number, invoice_date, invoice_kind, vendor_id").in("id", ids).in("invoice_kind", AP_BILL_KINDS);
        if (from) q = q.gte("invoice_date", from);
        if (to) q = q.lte("invoice_date", to);
        return q;
      });
      for (const v of invs) invById.set(v.id, v);
    }
    const vendIds = [...new Set([...invById.values()].map((v) => v.vendor_id).filter(Boolean))];
    const vendName = new Map();
    if (vendIds.length) {
      const vs = await fetchChunked(vendIds, (ids) => admin.from("vendors").select("id, name").in("id", ids));
      for (const v of vs) vendName.set(v.id, v.name);
    }
    // One row per (bill, color).
    const billMap = new Map();
    for (const l of liRows) {
      const inv = invById.get(l.invoice_id);
      if (!inv) continue; // filtered out (not a bill / outside date range)
      const color = colorByItem.get(l.inventory_item_id) ?? null;
      const key = `${l.invoice_id}|${color ?? ""}`;
      let r = billMap.get(key);
      if (!r) {
        r = {
          color, vendor: vendName.get(inv.vendor_id) || null, qty: 0, _amt: 0, _q: 0,
          ref: inv.invoice_number ?? null, bill_id: inv.id, po_number: null,
          receipt_type: inv.invoice_kind === "vendor_credit_memo" ? "Credit" : "Bill",
          receipt_date: null, bill_date: inv.invoice_date ?? null,
        };
        billMap.set(key, r);
      }
      if (!r.po_number && l.po_number) r.po_number = l.po_number; // first PO on the (bill,colour)
      const q = (Number(l.quantity) || 0) * packRatio;
      r.qty += q;
      // Prefer the P3 cents column; fall back to the legacy unit_price (money)
      // for bills synced before lines carried unit_cost_cents. Per-each price =
      // pack price ÷ units-per-pack so amount (price × exploded qty) is unchanged.
      const unitRaw = l.unit_cost_cents != null ? Number(l.unit_cost_cents) / 100 : (l.unit_price != null ? Number(l.unit_price) : null);
      const unit = unitRaw != null ? unitRaw / packRatio : null;
      if (unit != null) { r._amt += unit * q; r._q += q; }
    }
    // Bridge each bill row to a goods-receipt date via its PO number
    // (ip_receipts_history.po_number → latest received_date). Best-effort:
    // stays null when the receipt feed has no matching PO.
    const billPoNums = [...new Set([...billMap.values()].map((r) => r.po_number).filter(Boolean))];
    if (billPoNums.length) {
      const recv = await fetchChunked(billPoNums, (ids) =>
        admin.from("ip_receipts_history").select("po_number, received_date").in("po_number", ids));
      const recvByPo = new Map();
      for (const rr of recv) {
        if (!rr.po_number || !rr.received_date) continue;
        const cur = recvByPo.get(rr.po_number);
        if (!cur || String(rr.received_date) > cur) recvByPo.set(rr.po_number, String(rr.received_date));
      }
      for (const r of billMap.values()) if (r.po_number && recvByPo.has(r.po_number)) r.receipt_date = recvByPo.get(r.po_number);
    }
    for (const r of billMap.values()) {
      const { _amt, _q, ...rest } = r;
      rows.push({ ...rest, unit_price: _q > 0 ? +(_amt / _q).toFixed(4) : null });
    }

    // ── Xoro receipt mirror (historical; qty + receipt date only) ─────────────
    const rcRows = await fetchChunked(itemIds, (ids) => {
      let q = admin.from("ip_receipts_history").select("sku_id, qty, received_date, vendor_id, receipt_number").in("sku_id", ids);
      if (from) q = q.gte("received_date", from);
      if (to) q = q.lte("received_date", to);
      return q;
    });
    const rcVendIds = [...new Set(rcRows.map((r) => r.vendor_id).filter(Boolean))];
    const rcVendName = new Map();
    if (rcVendIds.length) {
      const vs = await fetchChunked(rcVendIds, (ids) => admin.from("ip_vendor_master").select("id, name").in("id", ids));
      for (const v of vs) rcVendName.set(v.id, v.name);
    }
    const recMap = new Map();
    for (const r of rcRows) {
      const color = colorByItem.get(r.sku_id) ?? null;
      const key = `${r.receipt_number ?? ""}|${color ?? ""}`;
      let row = recMap.get(key);
      if (!row) {
        row = { color, vendor: rcVendName.get(r.vendor_id) || null, qty: 0, unit_price: null,
          ref: r.receipt_number ?? null, bill_id: null, receipt_type: "Receipt",
          receipt_date: r.received_date ?? null, bill_date: null };
        recMap.set(key, row);
      }
      row.qty += (Number(r.qty) || 0) * packRatio;
    }
    for (const r of recMap.values()) rows.push(r);

    rows.sort((a, b) => String(b.bill_date || b.receipt_date || "").localeCompare(String(a.bill_date || a.receipt_date || "")));

    const colorMap = new Map();
    let grand = 0;
    for (const r of rows) {
      const k = r.color ?? "";
      let c = colorMap.get(k);
      if (!c) { c = { color: r.color ?? null, qty: 0 }; colorMap.set(k, c); }
      c.qty += r.qty; grand += r.qty;
    }
    const color_totals = [...colorMap.values()].sort((a, b) => b.qty - a.qty);

    return res.status(200).json({ color_totals, grand_total: grand, rows });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
