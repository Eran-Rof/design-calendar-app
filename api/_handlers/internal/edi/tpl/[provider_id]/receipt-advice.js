// api/internal/edi/tpl/:provider_id/receipt-advice
//
// INBOUND 3PL goods-receipt advice (X12 944 Stock Transfer Receipt Advice, or a
// structured JSON/CSV). The 3PL reports what it RECEIVED into the warehouse
// against one of our native purchase orders. This endpoint:
//   1. parses it into { po_number, receipt_date, lines: [{ sku, qty_received }] },
//   2. resolves the PO (must be issued/in_transit) + maps each SKU → its PO line,
//   3. stores the raw advice in edi_messages (transaction_set '944', inbound),
//   4. creates a **DRAFT** tanda_po_receipts (native-PO path) + lines.
//
// It deliberately does NOT post the receipt. The draft lands in Receiving
// (m=receiving) where the operator CONFIRMS and posts it — which is what creates
// the FIFO layers + GR/IR journal entry and flips the PO to received. (Operator
// confirmation is required for an EDI-driven receipt.)
//
// POST body (any of):
//   • raw X12 944 string, or { raw: "<X12>" }
//   • { po_number, receipt_date?, lines: [{ sku, qty_received }] }
//   • { po_number, receipt_date?, csv: "sku,qty\n..." }   (header row optional)

import { createClient } from "@supabase/supabase-js";
import { parse944 } from "../../../../../_lib/edi/builder.js";
import { parseEnvelope } from "../../../../../_lib/edi/parser.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIVABLE = ["issued", "in_transit"];

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function getProviderId(req) {
  if (req.query && req.query.provider_id) return req.query.provider_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("tpl");
  return idx >= 0 ? parts[idx + 1] : null;
}
const looseKey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);

// Tiny "sku,qty" CSV → [{ sku, qty_received }] (header row optional).
function parseReceiptCsv(csv) {
  const out = [];
  for (const line of String(csv || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [sku, qty] = t.split(",").map((x) => x.trim());
    if (!sku || /^sku$/i.test(sku)) continue;
    const q = Number(qty);
    if (Number.isFinite(q) && q > 0) out.push({ sku, qty_received: q });
  }
  return out;
}

// Normalize any accepted body into { po_number, receipt_date, lines, raw }.
function parseBody(req) {
  const b = req.body;
  if (typeof b === "string" && b.trim().startsWith("ISA")) {
    return { ...parse944(parseEnvelope(b)), raw: b };
  }
  if (b && typeof b === "object") {
    if (typeof b.raw === "string" && b.raw.trim().startsWith("ISA")) {
      return { ...parse944(parseEnvelope(b.raw)), raw: b.raw };
    }
    const lines = Array.isArray(b.lines)
      ? b.lines.map((l) => ({ sku: l.sku ?? l.item ?? null, qty_received: Number(l.qty_received ?? l.qty) || 0 })).filter((l) => l.sku && l.qty_received > 0)
      : (b.csv ? parseReceiptCsv(b.csv) : []);
    return { po_number: b.po_number || null, receipt_date: isoDate(b.receipt_date), lines, raw: JSON.stringify(b) };
  }
  return { po_number: null, receipt_date: null, lines: [], raw: null };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const providerId = getProviderId(req);
  if (!providerId || !UUID_RE.test(String(providerId))) return res.status(400).json({ error: "Invalid provider id" });
  const { data: provider } = await admin.from("tpl_providers").select("id, name, entity_id").eq("id", providerId).maybeSingle();
  if (!provider) return res.status(404).json({ error: "3PL provider not found" });

  const parsed = parseBody(req);
  if (!parsed.po_number) return res.status(400).json({ error: "Could not determine the PO number from the receipt advice (need po_number / REF*PO / N9*PO)." });
  if (parsed.lines.length === 0) return res.status(400).json({ error: "No received lines found in the advice." });

  // Resolve the native PO by number (entity-scoped to the provider's entity).
  let poQuery = admin.from("purchase_orders").select("id, entity_id, status, po_number, vendor_id").eq("po_number", parsed.po_number);
  if (provider.entity_id) poQuery = poQuery.eq("entity_id", provider.entity_id);
  const { data: po } = await poQuery.maybeSingle();

  // Always store the inbound advice (so unmatched ones stay auditable).
  const { data: msg } = await admin.from("edi_messages").insert({
    vendor_id: po?.vendor_id || null,
    direction: "inbound",
    transaction_set: "944",
    status: po ? "processed" : "received",
    raw_content: parsed.raw,
    parsed_content: parsed,
    tpl_provider_id: provider.id,
  }).select("id").maybeSingle();
  const ediMessageId = msg?.id || null;

  if (!po) return res.status(200).json({ ok: false, edi_message_id: ediMessageId, parsed, message: `944 stored but no native PO '${parsed.po_number}' for ${provider.name}.` });
  if (!RECEIVABLE.includes(po.status)) {
    return res.status(409).json({ ok: false, edi_message_id: ediMessageId, message: `PO ${po.po_number} is '${po.status}' — must be ${RECEIVABLE.join(" or ")} to receive.` });
  }

  // PO lines + their SKU codes → match each advice SKU to a PO line (loose key).
  const { data: poLines } = await admin.from("purchase_order_lines")
    .select("id, inventory_item_id, unit_cost_cents, qty_ordered, qty_received, status").eq("purchase_order_id", po.id);
  const itemIds = [...new Set((poLines || []).map((l) => l.inventory_item_id).filter(Boolean))];
  const skuByItem = new Map();
  if (itemIds.length) {
    const { data: items } = await admin.from("ip_item_master").select("id, sku_code").in("id", itemIds);
    for (const it of items || []) if (it.sku_code) skuByItem.set(it.id, it.sku_code);
  }
  // looseKey(sku_code) → PO line (prefer a non-cancelled line with remaining qty).
  const lineByLooseSku = new Map();
  for (const l of poLines || []) {
    if (l.status === "cancelled") continue;
    const lk = looseKey(skuByItem.get(l.inventory_item_id));
    if (!lk) continue;
    const prev = lineByLooseSku.get(lk);
    const remaining = Number(l.qty_ordered || 0) - Number(l.qty_received || 0);
    if (!prev || (remaining > (Number(prev.qty_ordered || 0) - Number(prev.qty_received || 0)))) lineByLooseSku.set(lk, l);
  }

  const receiptLines = [];
  const unmatched = [];
  for (const adv of parsed.lines) {
    const l = lineByLooseSku.get(looseKey(adv.sku));
    if (!l) { unmatched.push(adv.sku); continue; }
    const qty = Math.round(Number(adv.qty_received) || 0);
    if (qty <= 0) continue;
    receiptLines.push({
      purchase_order_line_id: l.id,
      qty_received: qty, qty_accepted: qty, qty_rejected: 0,
      unit_cost_cents: Number(l.unit_cost_cents) || 0,
      raw_payload: { source: "edi_944", sku: adv.sku, provider_id: provider.id },
    });
  }
  if (receiptLines.length === 0) {
    return res.status(409).json({ ok: false, edi_message_id: ediMessageId, unmatched_skus: unmatched, message: `No advice SKU matched a line on PO ${po.po_number}.` });
  }

  // Insert a DRAFT receipt (native-PO path). Operator confirms + posts in Receiving.
  const { data: header, error: hErr } = await admin.from("tanda_po_receipts").insert({
    purchase_order_id: po.id, tanda_po_id: null,
    receipt_date: parsed.receipt_date || new Date().toISOString().slice(0, 10),
    status: "draft",
    notes: `3PL EDI receipt advice (${provider.name}) — review & post to receive.`,
  }).select("id, status, receipt_date").single();
  if (hErr) return res.status(500).json({ error: `Draft receipt create failed: ${hErr.message}` });

  const { error: lErr } = await admin.from("tanda_po_receipt_lines").insert(receiptLines.map((l) => ({ ...l, receipt_id: header.id })));
  if (lErr) return res.status(500).json({ error: `Draft receipt ${header.id} saved but lines failed: ${lErr.message}` });

  return res.status(201).json({
    ok: true,
    edi_message_id: ediMessageId,
    receipt_id: header.id,
    status: "draft",
    purchase_order_id: po.id,
    po_number: po.po_number,
    matched_lines: receiptLines.length,
    unmatched_skus: unmatched,
    message: `Draft goods receipt created for PO ${po.po_number} (${receiptLines.length} line(s)${unmatched.length ? `, ${unmatched.length} unmatched SKU(s)` : ""}). Confirm & post it in Receiving to book inventory + GR/IR.`,
  });
}
