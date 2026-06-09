// api/internal/purchase-orders
//
// P16 / M11 — native Purchase Order list + create (origination).
//
// GET  ?status=&vendor_id=&q=&limit=   → PO headers for the default entity.
// POST { vendor_id, brand_id?, order_date?, expected_date?, payment_terms_id?,
//        notes?, lines: [{ inventory_item_id?, description?, qty_ordered,
//        unit_cost_cents? }] }
//        → creates a DRAFT PO (po_number is assigned later, on issue).
//
// Brand + entity scoped. Writes via service-role (anon-read RLS).

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope } from "../../../_lib/brandContext.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "issued", "in_transit", "received", "cancelled"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Brand-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntity(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data || null;
}

const SELECT_COLS =
  "id, entity_id, brand_id, vendor_id, po_number, order_date, expected_date, status, " +
  "currency, payment_terms_id, notes, subtotal_cents, total_cents, created_at, updated_at";

export function validateInsert(body) {
  if (!body || typeof body !== "object") return { error: "body required" };
  if (!body.vendor_id || !UUID_RE.test(String(body.vendor_id))) {
    return { error: "vendor_id (uuid) required" };
  }
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const normLines = [];
  let ln = 1;
  for (const l of lines) {
    const qty = Number(l.qty_ordered);
    if (!Number.isFinite(qty) || qty <= 0) continue; // skip empty/zero lines
    const unit = l.unit_cost_cents == null || l.unit_cost_cents === "" ? 0 : Math.round(Number(l.unit_cost_cents));
    if (!Number.isFinite(unit) || unit < 0) return { error: `line ${ln}: unit_cost_cents must be >= 0` };
    normLines.push({
      line_number: ln++,
      inventory_item_id: l.inventory_item_id && UUID_RE.test(String(l.inventory_item_id)) ? l.inventory_item_id : null,
      description: l.description ? String(l.description).trim() : null,
      qty_ordered: qty,
      unit_cost_cents: unit,
      line_total_cents: Math.round(qty * unit),
    });
  }
  if (normLines.length === 0) return { error: "at least one line with qty_ordered > 0 is required" };

  const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
  return {
    data: {
      vendor_id: body.vendor_id,
      brand_id: nz("brand_id"),
      order_date: /^\d{4}-\d{2}-\d{2}$/.test(body.order_date || "") ? body.order_date : null,
      expected_date: /^\d{4}-\d{2}-\d{2}$/.test(body.expected_date || "") ? body.expected_date : null,
      payment_terms_id: nz("payment_terms_id"),
      notes: body.notes ? String(body.notes).trim() : null,
      lines: normLines,
    },
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const status = (url.searchParams.get("status") || "").trim();
    const vendorId = (url.searchParams.get("vendor_id") || "").trim();
    const q = (url.searchParams.get("q") || "").trim();
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 500);
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });

    let query = admin.from("purchase_orders").select(SELECT_COLS)
      .eq("entity_id", entity.id)
      .order("order_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    query = applyBrandScope(query, req);
    if (status) query = query.eq("status", status);
    if (vendorId && UUID_RE.test(vendorId)) query = query.eq("vendor_id", vendorId);
    if (q) {
      // All-field search: PO #, notes, or vendor name/code. A parent column
      // can't be OR'd with an embedded one in a single PostgREST filter, so we
      // resolve matching vendor ids first and OR them into the header query.
      const like = `%${q}%`;
      const ors = [`po_number.ilike.${like}`, `notes.ilike.${like}`];
      const { data: vendorMatches } = await admin
        .from("vendors")
        .select("id")
        .or(`name.ilike.${like},code.ilike.${like}`)
        .limit(1000);
      const vendorIds = (vendorMatches || []).map((v) => v.id);
      if (vendorIds.length) ors.push(`vendor_id.in.(${vendorIds.join(",")})`);
      query = query.or(ors.join(","));
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const subtotal = v.data.lines.reduce((s, l) => s + l.line_total_cents, 0);
    const { data: header, error: hErr } = await admin.from("purchase_orders").insert({
      entity_id: entity.id,
      vendor_id: v.data.vendor_id,
      brand_id: v.data.brand_id || undefined, // undefined → DB default rof_default_brand_id()
      order_date: v.data.order_date || undefined,
      expected_date: v.data.expected_date,
      status: "draft",
      payment_terms_id: v.data.payment_terms_id,
      notes: v.data.notes,
      subtotal_cents: subtotal,
      total_cents: subtotal,
    }).select(SELECT_COLS).single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    const lineRows = v.data.lines.map((l) => ({ ...l, purchase_order_id: header.id }));
    const { error: lErr } = await admin.from("purchase_order_lines").insert(lineRows);
    if (lErr) return res.status(500).json({ error: `Header saved (${header.id}) but lines failed: ${lErr.message}` });

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
