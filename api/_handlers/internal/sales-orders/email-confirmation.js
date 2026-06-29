// api/internal/sales-orders/:id/email-confirmation
//
// POST — email a Sales Order CONFIRMATION to a customer contact (operator item 7).
//        Builds a branded HTML confirmation server-side from the SO (authoritative,
//        not client-trusted) and sends it via Resend. Optionally attaches selected
//        SUPPORTING DOCUMENTS already on the order (the operator chooses which) —
//        each is validated to belong to this SO, then sent via a short-lived signed
//        URL as a Resend attachment.
//
// Body: { to_email (required), to_name?, cc?: string[], subject?, message?,
//         document_ids?: string[] }
//
// Returns: { sent: true, message_id, attachments: <n> } or { error }.

import { createClient } from "@supabase/supabase-js";
import { signedUrl } from "../../../_lib/documents/index.js";

export const config = { maxDuration: 30 };

const RESEND_API = "https://api.resend.com/emails";
const DEFAULT_FROM = process.env.RESEND_FROM || "Ring of Fire <noreply@ringoffireclothing.com>";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso) => {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso); // US MM/DD/YYYY
};

function confirmationHtml({ so, customerName, shipTo, terms, lines }) {
  const rows = lines.map((l) => {
    const label = [l.style_code, l.color, l.size].filter(Boolean).join(" / ") || l.sku_code || l.description || "(item)";
    const qty = Number(l.qty_ordered) || 0;
    const unit = Number(l.unit_price_cents) || 0;
    const ext = l.line_total_cents != null ? Number(l.line_total_cents) : qty * unit;
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${esc(label)}${l.lot_number ? ` <span style="color:#6b7280">· lot ${esc(l.lot_number)}</span>` : ""}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${qty.toLocaleString()}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${money(unit)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${money(ext)}</td>
    </tr>`;
  }).join("");
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty_ordered) || 0), 0);
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;color:#111827">
  <div style="max-width:680px;margin:0 auto;padding:24px">
    <div style="background:linear-gradient(135deg,#CC2200,#7f1d1d);color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
      <div style="font-size:20px;font-weight:800;letter-spacing:.5px">RING OF FIRE</div>
      <div style="font-size:13px;opacity:.9">Sales Order Confirmation</div>
    </div>
    <div style="background:#fff;padding:22px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px">
      <table style="width:100%;font-size:13px;margin-bottom:16px"><tr>
        <td style="vertical-align:top">
          <div style="color:#6b7280">Order</div><div style="font-weight:700;font-size:15px">${esc(so.so_number || "(draft)")}</div>
          <div style="color:#6b7280;margin-top:8px">Customer</div><div style="font-weight:600">${esc(customerName)}</div>
          ${so.customer_po ? `<div style="color:#6b7280;margin-top:8px">Your PO #</div><div>${esc(so.customer_po)}</div>` : ""}
        </td>
        <td style="vertical-align:top;text-align:right">
          <div style="color:#6b7280">Order date</div><div>${fmtDate(so.order_date)}</div>
          <div style="color:#6b7280;margin-top:8px">Start ship</div><div>${fmtDate(so.requested_ship_date)}</div>
          ${terms ? `<div style="color:#6b7280;margin-top:8px">Terms</div><div>${esc(terms)}</div>` : ""}
        </td>
      </tr></table>
      ${shipTo ? `<div style="font-size:13px;margin-bottom:14px"><span style="color:#6b7280">Ship to:</span> ${esc(shipTo)}</div>` : ""}
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#f9fafb;color:#374151">
          <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb">Item</th>
          <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #e5e7eb">Qty</th>
          <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #e5e7eb">Unit</th>
          <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #e5e7eb">Total</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="font-weight:800">
          <td style="padding:10px;text-align:left">Total</td>
          <td style="padding:10px;text-align:right">${totalQty.toLocaleString()}</td>
          <td></td>
          <td style="padding:10px;text-align:right;color:#065f46">${money(so.total_cents)}</td>
        </tr></tfoot>
      </table>
      <div style="margin-top:18px;font-size:12px;color:#6b7280">Please review and reply with any corrections. Thank you for your order.</div>
    </div>
  </div></body></html>`;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const toEmail = String(body.to_email || "").trim();
  if (!EMAIL_RE.test(toEmail)) return res.status(400).json({ error: "A valid to_email is required" });
  const cc = Array.isArray(body.cc) ? body.cc.map((e) => String(e).trim()).filter((e) => EMAIL_RE.test(e)) : [];
  const docIds = Array.isArray(body.document_ids) ? body.document_ids.filter((d) => UUID_RE.test(String(d))) : [];

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(503).json({ error: "Email is not configured (RESEND_API_KEY missing)." });

  // Load the SO header (authoritative).
  const { data: so, error: soErr } = await admin.from("sales_orders")
    .select("id, so_number, customer_id, ship_to_location_id, order_date, requested_ship_date, customer_po, payment_terms_id, total_cents, status")
    .eq("id", id).maybeSingle();
  if (soErr) return res.status(500).json({ error: soErr.message });
  if (!so) return res.status(404).json({ error: "Sales order not found" });

  // Customer name, ship-to, terms, lines.
  const [{ data: cust }, { data: terms }] = await Promise.all([
    admin.from("customers").select("name").eq("id", so.customer_id).maybeSingle(),
    so.payment_terms_id ? admin.from("payment_terms").select("name").eq("id", so.payment_terms_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  let shipTo = null;
  if (so.ship_to_location_id) {
    const { data: loc } = await admin.from("customer_locations").select("name, code, address").eq("id", so.ship_to_location_id).maybeSingle();
    if (loc) shipTo = [loc.code, loc.name].filter(Boolean).join(" — ") || loc.name || null;
  }
  const { data: rawLines } = await admin.from("sales_order_lines")
    .select("inventory_item_id, description, qty_ordered, unit_price_cents, line_total_cents, lot_number, line_number")
    .eq("sales_order_id", id).order("line_number", { ascending: true });
  const lines = rawLines || [];
  const itemIds = [...new Set(lines.map((l) => l.inventory_item_id).filter(Boolean))];
  if (itemIds.length) {
    const { data: skus } = await admin.from("ip_item_master").select("id, style_code, color, size, sku_code").in("id", itemIds);
    const byId = new Map((skus || []).map((s) => [s.id, s]));
    for (const l of lines) { const s = l.inventory_item_id ? byId.get(l.inventory_item_id) : null; Object.assign(l, { style_code: s?.style_code, color: s?.color, size: s?.size, sku_code: s?.sku_code }); }
  }

  // Resolve the selected supporting documents → Resend attachments, but only ones
  // that actually belong to THIS sales order (never attach an arbitrary doc id).
  let attachments = [];
  if (docIds.length) {
    const { data: ownDocs } = await admin.from("documents")
      .select("id").eq("context_table", "sales_orders").eq("context_id", id).in("id", docIds);
    const allowed = new Set((ownDocs || []).map((d) => d.id));
    for (const did of docIds) {
      if (!allowed.has(did)) continue;
      try {
        const su = await signedUrl(admin, { document_id: did, ttl_seconds: 900 });
        if (su?.url) attachments.push({ filename: su.filename || "document", path: su.url });
      } catch { /* skip a doc that can't be signed */ }
    }
  }

  const customerName = cust?.name || "Customer";
  const subject = String(body.subject || "").trim() || `Order confirmation — ${so.so_number || "Sales Order"}`;
  const intro = String(body.message || "").trim();
  const html = (intro ? `<div style="max-width:680px;margin:0 auto;padding:0 24px 4px;font-family:'Segoe UI',Arial,sans-serif;color:#374151;font-size:13px">${esc(intro).replace(/\n/g, "<br>")}</div>` : "")
    + confirmationHtml({ so, customerName, shipTo, terms: terms?.name || null, lines });

  // Send via Resend.
  try {
    const r = await fetch(RESEND_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: DEFAULT_FROM,
        to: [toEmail],
        ...(cc.length ? { cc } : {}),
        subject,
        html,
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
    if (!r.ok) return res.status(502).json({ error: `Email send failed: ${parsed?.message || parsed?.error || `HTTP ${r.status}`}` });
    return res.status(200).json({ sent: true, message_id: parsed?.id || null, attachments: attachments.length, to: toEmail });
  } catch (e) {
    return res.status(502).json({ error: `Email send failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
