// api/internal/sales-orders/:id/wave
//
// P21 follow-up / M13 — WAVE a sales order to a 3PL via EDI 940 (Warehouse
// Shipping Order). "Waving" releases an allocated SO to the contract 3PL that
// holds our stock: it
//   1. validates the SO is allocated/fulfilling with allocated qty,
//   2. resolves an active 3PL provider,
//   3. creates an OUTBOUND tpl_shipment (status 'released') + lines from the
//      SO's allocated lines (qty = qty_allocated), resolving item uuids to SKU,
//   4. generates an X12 940 with the existing ISA/GS envelope builder and
//      stores it in edi_messages (transaction_set '940'),
//   5. transmits it to the 3PL (live SFTP if configured; otherwise stores +
//      queues — see api/_lib/edi/transport.js),
//   6. stamps the SO with waved_at / waved_tpl_provider_id.
//
// Body: { tpl_provider_id (uuid, required), actor_user_id? }
// 201:  { tpl_shipment_id, edi_940_message_id, transmitted, message }
//
// NOTE: live transmission needs the 3PL's real endpoint + credentials on the
// tpl_providers row (edi_protocol/edi_endpoint/edi_username/edi_credential_ref).
// Until those are set the 940 generates + queues but does not transmit. See
// docs/tangerine/OPERATOR-TODO.md.

import { createClient } from "@supabase/supabase-js";
import { build940 } from "../../../_lib/edi/builder.js";
import { transmitEdi } from "../../../_lib/edi/transport.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function nextShipmentNumber(admin, entityId) {
  const year = new Date().getUTCFullYear();
  const prefix = `TPL-${year}-`;
  const { data } = await admin.from("tpl_shipments").select("shipment_number")
    .eq("entity_id", entityId).like("shipment_number", `${prefix}%`)
    .order("shipment_number", { ascending: false }).limit(1);
  let n = 1;
  if (data && data[0] && data[0].shipment_number) {
    const p = parseInt(String(data[0].shipment_number).slice(prefix.length), 10);
    if (Number.isFinite(p)) n = p + 1;
  }
  return `${prefix}${String(n).padStart(5, "0")}`;
}

function addressFromJson(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  return {
    address: a.address1 || a.address || a.line1 || a.street || "",
    city: a.city || "",
    state: a.state || a.province || a.region || "",
    zip: a.zip || a.postal_code || a.postcode || a.zip_code || "",
    country: a.country || a.country_code || "US",
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const tplProviderId = String(body.tpl_provider_id || "");
  if (!UUID_RE.test(tplProviderId)) return res.status(400).json({ error: "tpl_provider_id (uuid) is required" });
  const actor = (body.actor_user_id && UUID_RE.test(String(body.actor_user_id))) ? String(body.actor_user_id) : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Load SO + require allocated/fulfilling.
  const { data: so, error: soErr } = await admin
    .from("sales_orders")
    .select("id, status, entity_id, customer_id, ship_to_location_id, so_number, waved_at")
    .eq("id", id).maybeSingle();
  if (soErr) return res.status(500).json({ error: soErr.message });
  if (!so) return res.status(404).json({ error: "Sales order not found" });
  if (!["allocated", "fulfilling"].includes(so.status)) {
    return res.status(409).json({ error: `Cannot wave a ${so.status} sales order — allocate it first (status must be allocated or fulfilling).` });
  }
  if (so.waved_at) {
    return res.status(409).json({ error: `Sales order already waved at ${so.waved_at}. Cancel the existing 3PL shipment before re-waving.` });
  }

  // 2. Resolve active 3PL provider.
  const { data: provider, error: pErr } = await admin
    .from("tpl_providers")
    .select("id, name, code, is_active, edi_protocol, edi_endpoint, edi_username, edi_credential_ref")
    .eq("id", tplProviderId).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!provider) return res.status(400).json({ error: "3PL provider not found" });
  if (provider.is_active === false) return res.status(400).json({ error: `3PL provider '${provider.name}' is inactive` });

  // 3. Load allocated lines (qty_allocated − qty_shipped remaining > 0).
  const { data: lines, error: lErr } = await admin
    .from("sales_order_lines")
    .select("id, line_number, inventory_item_id, description, qty_ordered, qty_allocated, qty_shipped, status")
    .eq("sales_order_id", id).order("line_number", { ascending: true });
  if (lErr) return res.status(500).json({ error: lErr.message });

  const waveLines = [];
  for (const ln of lines || []) {
    if (ln.status === "cancelled") continue;
    const remaining = Number(ln.qty_allocated) - Number(ln.qty_shipped);
    if (remaining > 0) waveLines.push({ line: ln, qty: remaining });
  }
  if (waveLines.length === 0) {
    return res.status(409).json({ error: "Nothing to wave — no allocated, unshipped quantity on this sales order. Allocate stock first." });
  }

  // Resolve item uuids → sku (no raw uuids in human-facing fields).
  const itemIds = [...new Set(waveLines.map((w) => w.line.inventory_item_id).filter(Boolean))];
  const skuById = new Map();
  if (itemIds.length) {
    const { data: items } = await admin.from("ip_item_master").select("id, sku_code, style_code, color, size").in("id", itemIds);
    for (const it of items || []) {
      const label = it.sku_code || [it.style_code, it.color, it.size].filter(Boolean).join("-") || null;
      skuById.set(it.id, label);
    }
  }

  // Resolve ship-to + ship-from for the 940 parties.
  let shipTo = { name: "", address: "", city: "", state: "", zip: "", country: "US" };
  const { data: cust } = await admin.from("customers").select("customer_name, shipping_address").eq("id", so.customer_id).maybeSingle();
  shipTo.name = cust?.customer_name || "Customer";
  if (so.ship_to_location_id) {
    const { data: loc } = await admin.from("customer_locations").select("name, address").eq("id", so.ship_to_location_id).maybeSingle();
    if (loc) { shipTo.name = loc.name || shipTo.name; Object.assign(shipTo, addressFromJson(loc.address)); }
  } else if (cust?.shipping_address) {
    Object.assign(shipTo, addressFromJson(cust.shipping_address));
  }

  // 4. Create the OUTBOUND tpl_shipment (status 'released') + lines.
  const shipmentNumber = await nextShipmentNumber(admin, so.entity_id);
  const { data: shipment, error: shErr } = await admin
    .from("tpl_shipments")
    .insert({
      entity_id: so.entity_id,
      tpl_provider_id: provider.id,
      shipment_number: shipmentNumber,
      direction: "outbound",
      status: "released",
      reference: so.so_number || null,
      sales_order_id: so.id,
      notes: `Waved from sales order ${so.so_number || so.id} to 3PL ${provider.name}`,
      waved_at: new Date().toISOString(),
      confirmed_at: new Date().toISOString(),
      created_by_user_id: actor,
    })
    .select("id, shipment_number")
    .single();
  if (shErr) return res.status(500).json({ error: `3PL shipment create failed: ${shErr.message}` });

  const shipLineRows = waveLines.map((w, i) => ({
    tpl_shipment_id: shipment.id,
    line_number: i + 1,
    inventory_item_id: w.line.inventory_item_id || null,
    description: w.line.description || skuById.get(w.line.inventory_item_id) || null,
    qty: w.qty,
  }));
  const { error: slErr } = await admin.from("tpl_shipment_lines").insert(shipLineRows);
  if (slErr) {
    await admin.from("tpl_shipments").delete().eq("id", shipment.id);
    return res.status(500).json({ error: `3PL shipment lines failed: ${slErr.message}` });
  }

  // 5. Build the 940.
  // Sender/receiver come from edi_settings (our ISA/GS sender) + the provider's
  // EDI id (fall back to the provider code / RINGOFFIRE so a message is always
  // produced even before VAN config exists).
  const { data: ediSettings } = await admin
    .from("edi_settings").select("isa_sender_id, gs_sender_id, test_mode").eq("entity_id", so.entity_id).maybeSingle();
  const sender = ediSettings?.gs_sender_id || ediSettings?.isa_sender_id || "RINGOFFIRE";
  const receiver = provider.code || provider.name?.slice(0, 15).toUpperCase().replace(/\s+/g, "") || "TPL";
  const controlNumber = Math.floor(Date.now() / 1000) % 1_000_000_000;

  const ediLineItems = waveLines.map((w, i) => ({
    line: i + 1,
    sku: skuById.get(w.line.inventory_item_id) || "",
    qty: w.qty,
    unit: "EA",
    description: w.line.description || skuById.get(w.line.inventory_item_id) || "",
  }));

  const envelope940 = build940({
    sender, receiver, controlNumber,
    order: {
      shipment_number: shipment.shipment_number,
      order_date: new Date(),
      po_number: so.so_number || "",
      ship_to: shipTo,
      ship_from: { name: provider.name },
      line_items: ediLineItems,
    },
  });

  // Store the 940 (status 'generated').
  const { data: msg, error: msgErr } = await admin.from("edi_messages").insert({
    vendor_id: null,
    direction: "outbound",
    transaction_set: "940",
    status: "generated",
    raw_content: envelope940,
    tpl_shipment_id: shipment.id,
    sales_order_id: so.id,
    tpl_provider_id: provider.id,
    interchange_id: String(controlNumber),
  }).select("id").single();
  if (msgErr) {
    // 940 is the deliverable; if it can't be stored, roll back the shipment.
    await admin.from("tpl_shipment_lines").delete().eq("tpl_shipment_id", shipment.id);
    await admin.from("tpl_shipments").delete().eq("id", shipment.id);
    return res.status(500).json({ error: `940 message store failed: ${msgErr.message}` });
  }

  // 6. Transmit (live SFTP if configured; otherwise store + queue).
  const { transmitted, detail } = await transmitEdi({
    payload: envelope940,
    provider,
    filename: `940_${shipment.shipment_number}.edi`,
  });
  await admin.from("edi_messages").update({
    status: transmitted ? "sent" : "queued",
    transmitted: !!transmitted,
    transport_detail: detail,
    updated_at: new Date().toISOString(),
  }).eq("id", msg.id);

  // 7. Stamp the SO as waved.
  await admin.from("sales_orders").update({
    waved_at: new Date().toISOString(),
    waved_tpl_provider_id: provider.id,
    status: so.status === "allocated" ? "fulfilling" : so.status,
    updated_at: new Date().toISOString(),
  }).eq("id", so.id);

  const message = transmitted
    ? `Waved to ${provider.name}. 940 generated and transmitted (${detail}).`
    : `Waved to ${provider.name}. 940 generated and QUEUED — not yet transmitted (${detail}).`;

  return res.status(201).json({
    tpl_shipment_id: shipment.id,
    shipment_number: shipment.shipment_number,
    edi_940_message_id: msg.id,
    transmitted: !!transmitted,
    transport_detail: detail,
    lines_waved: waveLines.length,
    message,
  });
}
