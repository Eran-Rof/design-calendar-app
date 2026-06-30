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
import { matchPrepackMatrix } from "../../../_lib/styleMatrix.js";

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

// Is this line a prepack (PPK) line? Canonical grain rule: the style_code carries
// PPK (the line stores a number of PACKS, with size = the pack token e.g. PPK24).
export const isPpkLine = (l) => /PPK/i.test(String(l.style_code ?? l.sku_code ?? ""));

// Resolve ONE primary (web-res) image URL per style code → Map<STYLE_CODE_UPPER,
// signedUrl>. Self-contained mirror of pim/style-thumbs-by-code (default image
// only), used to embed images in the emailed confirmation (item 25). Best-effort.
async function resolveStyleImagesByCode(admin, styleCodes) {
  const BUCKET = "pim-images";
  const codes = [...new Set((styleCodes || []).filter(Boolean).map((c) => String(c).trim().toUpperCase()))];
  if (codes.length === 0) return new Map();
  // style_code → style_master.id (style_master can exceed the 1000-row cap → page).
  const codeToId = new Map();
  for (let from = 0; from < 100000; from += 1000) {
    const { data } = await admin.from("style_master").select("id, style_code").order("id", { ascending: true }).range(from, from + 999);
    for (const r of data || []) {
      const u = (r.style_code || "").trim().toUpperCase();
      if (u && r.id && codes.includes(u) && !codeToId.has(u)) codeToId.set(u, r.id);
    }
    if (!data || data.length < 1000) break;
  }
  const ids = [...codeToId.values()];
  if (ids.length === 0) return new Map();
  const { data: imgs } = await admin.from("product_images")
    .select("style_id, is_primary, sort_order, storage_path_thumb, storage_path_web")
    .in("style_id", ids)
    .order("is_primary", { ascending: false })
    .order("sort_order", { ascending: true });
  const pathByStyle = new Map();
  for (const r of imgs || []) {
    if (pathByStyle.has(r.style_id)) continue;
    const p = r.storage_path_web || r.storage_path_thumb;
    if (p) pathByStyle.set(r.style_id, p);
  }
  const paths = [...new Set(pathByStyle.values())];
  if (paths.length === 0) return new Map();
  const { data: signed } = await admin.storage.from(BUCKET).createSignedUrls(paths, 3600);
  const urlByPath = new Map();
  for (const s of signed || []) if (s && !s.error && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
  const out = new Map();
  for (const [code, id] of codeToId) {
    const p = pathByStyle.get(id);
    const u = p ? urlByPath.get(p) : null;
    if (u) out.set(code, u);
  }
  return out;
}

// For an order with PPK styles, build a per-style breakdown showing (a) the pack
// composition — the INNER PACK and CARTON PACK units per size — and (b) the full
// EXPLODE matrix: per color, packs × the carton-pack composition = garment units.
// `matrices` is the prepack_matrices set (each with a `sizes` array). Returns ""
// when the order has no PPK lines.
export function prepackBreakdownHtml(lines, matrices) {
  const byStyle = new Map(); // style_code → { style_code, packToken, colorRows:[{color,packs}] }
  for (const l of lines) {
    if (!isPpkLine(l)) continue;
    const key = l.style_code || l.sku_code || "(prepack)";
    let g = byStyle.get(key);
    if (!g) { g = { style_code: l.style_code || key, packToken: l.size || null, colorRows: [] }; byStyle.set(key, g); }
    g.colorRows.push({ color: l.color || "(no color)", packs: Number(l.qty_ordered) || 0 });
  }
  if (byStyle.size === 0) return "";

  const cell = "padding:5px 9px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums";
  const head = "padding:6px 9px;border-bottom:2px solid #e5e7eb;text-align:right;color:#374151";
  const blocks = [];
  for (const g of byStyle.values()) {
    const m = matchPrepackMatrix(g.style_code, g.packToken, matrices);
    const title = `${esc(g.style_code)}${g.packToken ? ` · ${esc(g.packToken)}` : ""}`;
    if (!m || !Array.isArray(m.sizes) || m.sizes.length === 0) {
      blocks.push(`<div style="margin-top:14px;font-size:12px;color:#6b7280">Prepack <b style="color:#374151">${title}</b> — no size breakdown is defined for this pack yet.</div>`);
      continue;
    }
    const sizes = [...m.sizes].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.size).localeCompare(String(b.size)));
    const hasInner = sizes.some((s) => Number(s.inner_pack_qty) > 0);
    const cartonTotal = sizes.reduce((a, s) => a + (Number(s.qty_per_pack) || 0), 0);
    const innerTotal = sizes.reduce((a, s) => a + (Number(s.inner_pack_qty) || 0), 0);
    const sizeHeadCells = sizes.map((s) => `<th style="${head}">${esc(s.size)}</th>`).join("");

    // (a) Pack composition — inner pack + carton pack units per size (one pack).
    const innerRow = hasInner ? `<tr>
      <td style="padding:5px 9px;border-bottom:1px solid #e5e7eb;text-align:left;color:#374151">Inner pack</td>
      ${sizes.map((s) => `<td style="${cell}">${(Number(s.inner_pack_qty) || 0).toLocaleString()}</td>`).join("")}
      <td style="${cell};font-weight:700">${innerTotal.toLocaleString()}</td></tr>` : "";
    const cartonRow = `<tr>
      <td style="padding:5px 9px;border-bottom:1px solid #e5e7eb;text-align:left;color:#374151">Carton pack</td>
      ${sizes.map((s) => `<td style="${cell}">${(Number(s.qty_per_pack) || 0).toLocaleString()}</td>`).join("")}
      <td style="${cell};font-weight:700">${cartonTotal.toLocaleString()}</td></tr>`;
    const compTable = `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px">
      <thead><tr style="background:#f9fafb"><th style="${head};text-align:left">Per pack</th>${sizeHeadCells}<th style="${head}">Pack</th></tr></thead>
      <tbody>${innerRow}${cartonRow}</tbody></table>`;

    // (b) Full explode — per color, packs × carton-pack qty per size = garment units.
    const sizeTotals = sizes.map(() => 0);
    let grandUnits = 0, grandPacks = 0;
    const colorRowsHtml = g.colorRows.map((cr) => {
      const tds = sizes.map((s, i) => { const u = cr.packs * (Number(s.qty_per_pack) || 0); sizeTotals[i] += u; return `<td style="${cell}">${u.toLocaleString()}</td>`; }).join("");
      const rowUnits = cr.packs * cartonTotal; grandUnits += rowUnits; grandPacks += cr.packs;
      return `<tr>
        <td style="padding:5px 9px;border-bottom:1px solid #e5e7eb;text-align:left">${esc(cr.color)}</td>
        ${tds}
        <td style="${cell};font-weight:700">${rowUnits.toLocaleString()}</td>
        <td style="${cell};color:#6b7280">${cr.packs.toLocaleString()}</td></tr>`;
    }).join("");
    const explodeTable = `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px">
      <thead><tr style="background:#f9fafb"><th style="${head};text-align:left">Color</th>${sizeHeadCells}<th style="${head}">Units</th><th style="${head}">Packs</th></tr></thead>
      <tbody>${colorRowsHtml}</tbody>
      <tfoot><tr style="font-weight:800">
        <td style="padding:6px 9px;text-align:left">Total</td>
        ${sizeTotals.map((t) => `<td style="${cell}">${t.toLocaleString()}</td>`).join("")}
        <td style="${cell}">${grandUnits.toLocaleString()}</td>
        <td style="${cell}">${grandPacks.toLocaleString()}</td></tr></tfoot></table>`;

    blocks.push(`<div style="margin-top:16px">
      <div style="font-size:13px;font-weight:700;color:#111827">Prepack breakdown — ${title}</div>
      <div style="font-size:11px;color:#6b7280;margin:2px 0 2px">Pack composition (units per pack)</div>
      ${compTable}
      <div style="font-size:11px;color:#6b7280;margin:8px 0 2px">Full size breakdown (packs exploded to garment units)</div>
      ${explodeTable}
    </div>`);
  }
  return `<div style="margin-top:20px;border-top:1px solid #e5e7eb;padding-top:6px">
    <div style="font-size:13px;font-weight:800;color:#111827;margin-bottom:2px">Prepack (PPK) detail</div>
    ${blocks.join("")}
  </div>`;
}

function confirmationHtml({ so, customerName, shipTo, terms, lines, prepackHtml = "", styleImages = null }) {
  // Item 25 — show the style image once per style (first line that carries it).
  const seenImg = new Set();
  const rows = lines.map((l) => {
    const label = [l.style_code, l.color, l.size].filter(Boolean).join(" / ") || l.sku_code || l.description || "(item)";
    const qty = Number(l.qty_ordered) || 0;
    const unit = Number(l.unit_price_cents) || 0;
    const ext = l.line_total_cents != null ? Number(l.line_total_cents) : qty * unit;
    let img = "";
    if (styleImages && l.style_code) {
      const k = String(l.style_code).toUpperCase();
      const url = styleImages.get(k);
      if (url && !seenImg.has(k)) { seenImg.add(k); img = `<img src="${esc(url)}" alt="" style="width:38px;height:38px;object-fit:cover;border:1px solid #e5e7eb;border-radius:4px;vertical-align:middle;margin-right:8px" />`; }
    }
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${img}${esc(label)}${l.lot_number ? ` <span style="color:#6b7280">· lot ${esc(l.lot_number)}</span>` : ""}</td>
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
      ${prepackHtml}
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
  const withImages = body.with_images === true; // item 25 — embed style images

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

  // PPK breakdown — when the order carries prepack styles, load their prepack
  // matrices (with the per-size inner-pack / carton-pack composition) so the
  // confirmation can show the pack matrix + full garment explode.
  let prepackHtml = "";
  if (lines.some(isPpkLine)) {
    const { data: mRows } = await admin.from("prepack_matrices")
      .select("id, ppk_style_code, pack_token, pack_total, name").not("ppk_style_code", "is", null);
    const matrices = mRows || [];
    if (matrices.length) {
      const { data: sRows } = await admin.from("prepack_matrix_sizes")
        .select("matrix_id, size, qty_per_pack, inner_pack_qty, sort_order")
        .in("matrix_id", matrices.map((m) => m.id));
      const sizesByMatrix = new Map();
      for (const r of sRows || []) {
        if (!sizesByMatrix.has(r.matrix_id)) sizesByMatrix.set(r.matrix_id, []);
        sizesByMatrix.get(r.matrix_id).push(r);
      }
      for (const m of matrices) m.sizes = sizesByMatrix.get(m.id) || [];
    }
    prepackHtml = prepackBreakdownHtml(lines, matrices);
  }

  // Item 25 — resolve a primary image per style (web-res) when the operator had
  // "Show images" on, so the emailed confirmation matches the on-screen/print view.
  let styleImages = null;
  if (withImages) {
    try { styleImages = await resolveStyleImagesByCode(admin, lines.map((l) => l.style_code)); }
    catch { styleImages = null; /* non-fatal — email still sends without images */ }
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
    + confirmationHtml({ so, customerName, shipTo, terms: terms?.name || null, lines, prepackHtml, styleImages });

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
