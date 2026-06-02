// api/internal/sales-orders/:id/split
//
// P16 item 15 — split a draft sales order across multiple ship-to locations
// (the customer's stores / DCs). Creates one CHILD sales order per location,
// copying the header + lines; each line's qty is split evenly across the chosen
// locations (floor, with the remainder going to the first child). The source SO
// becomes the umbrella parent (is_split_parent=true). Mostly EDI-driven; this
// powers the manual "ship to multiple stores" path too.
//
// Body: { location_ids: [uuid, ...] }   (2 or more)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Header columns copied verbatim onto each child SO (everything except identity,
// number, status, totals, timestamps, and the split linkage).
const COPY_HEADER_COLS = [
  "entity_id", "brand_id", "channel_id", "customer_id", "order_date",
  "requested_ship_date", "cancel_date", "currency", "payment_terms_id",
  "ar_account_id", "revenue_account_id", "notes",
  "factor_approval_status", "factor_approved_cents", "factor_reference", "factor_source",
];

// Split a quantity n ways evenly: floor each, give the leftover units to the
// earliest children so the parts sum back to the original.
function splitQty(total, parts) {
  const t = Number(total) || 0;
  const base = Math.floor(t / parts);
  let remainder = t - base * parts;
  const out = [];
  for (let i = 0; i < parts; i++) {
    out.push(base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder--;
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const locationIds = Array.isArray(body?.location_ids)
    ? body.location_ids.filter((l) => typeof l === "string" && UUID_RE.test(l))
    : [];
  if (locationIds.length < 2) {
    return res.status(400).json({ error: "Pick at least two ship-to locations to split across." });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: so, error: soErr } = await admin.from("sales_orders").select("*").eq("id", id).maybeSingle();
  if (soErr) return res.status(500).json({ error: soErr.message });
  if (!so) return res.status(404).json({ error: "Sales order not found" });
  if (so.status !== "draft") {
    return res.status(409).json({ error: `Only a draft sales order can be split (this one is ${so.status}).` });
  }
  if (so.is_split_parent) {
    return res.status(409).json({ error: "This sales order has already been split." });
  }

  const { data: lines, error: lErr } = await admin
    .from("sales_order_lines").select("*").eq("sales_order_id", id).order("line_number", { ascending: true });
  if (lErr) return res.status(500).json({ error: lErr.message });
  if (!lines || lines.length === 0) {
    return res.status(400).json({ error: "Cannot split a sales order with no lines." });
  }

  // Validate the chosen locations belong to this customer.
  const { data: locs } = await admin
    .from("customer_locations").select("id, name").eq("customer_id", so.customer_id).in("id", locationIds);
  const validIds = new Set((locs || []).map((l) => l.id));
  const targets = locationIds.filter((l) => validIds.has(l));
  if (targets.length < 2) {
    return res.status(400).json({ error: "At least two of the chosen locations must belong to this customer." });
  }

  // Pre-compute the per-child quantities for each line.
  const perLineSplits = lines.map((ln) => splitQty(ln.qty_ordered, targets.length));

  const children = [];
  for (let ci = 0; ci < targets.length; ci++) {
    const header = {};
    for (const col of COPY_HEADER_COLS) header[col] = so[col];
    header.ship_to_location_id = targets[ci];
    header.parent_sales_order_id = so.id;
    header.status = "draft";

    const { data: child, error: cErr } = await admin.from("sales_orders").insert(header).select("id").single();
    if (cErr) return res.status(500).json({ error: `Failed to create child SO: ${cErr.message}` });

    const childLines = lines
      .map((ln, li) => ({
        sales_order_id: child.id,
        line_number: ln.line_number,
        inventory_item_id: ln.inventory_item_id,
        description: ln.description,
        qty_ordered: perLineSplits[li][ci],
        unit_price_cents: ln.unit_price_cents,
        line_total_cents: Math.round(perLineSplits[li][ci] * Number(ln.unit_price_cents)),
        revenue_account_id: ln.revenue_account_id,
      }))
      .filter((l) => Number(l.qty_ordered) > 0); // drop zero-qty lines on a child

    if (childLines.length > 0) {
      const { error: clErr } = await admin.from("sales_order_lines").insert(childLines);
      if (clErr) return res.status(500).json({ error: `Child SO ${child.id} created but lines failed: ${clErr.message}` });
    }
    children.push({ id: child.id, ship_to_location_id: targets[ci] });
  }

  // Mark the source as the umbrella parent (its quantities now live on children).
  await admin.from("sales_orders").update({ is_split_parent: true, updated_at: new Date().toISOString() }).eq("id", so.id);

  return res.status(201).json({
    parent_id: so.id,
    children,
    count: children.length,
    message: `Split into ${children.length} per-store sales orders. Adjust each child's quantities as needed, then confirm.`,
  });
}
