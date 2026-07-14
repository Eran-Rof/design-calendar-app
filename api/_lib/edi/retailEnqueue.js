// api/_lib/edi/retailEnqueue.js
//
// Generate + queue OUTBOUND retail EDI (856 ASN + 810 invoice) for an AR invoice
// posted to an EDI-enabled retail customer. Called (non-fatally) from the AR
// invoice post flow; also drivable from a manual "Generate EDI" UI action.
//
// Flow: resolve the customer's active edi_customer_partners row → build the
// shipment/invoice domain objects from ar_invoices + lines + ship-to + company
// GS1 settings → build856/build810 → INSERT edi_messages rows (direction
// outbound, status 'queued', linked to the partner + invoice). The EXISTING
// transport cron picks them up and transmits over the partner's SFTP connection;
// nothing transmits here, and nothing transmits at all until the partner has
// resolvable credentials (INERT-SAFE). Dedupe: a UNIQUE index on
// (partner, transaction_set, ar_invoice_id) means a re-post never double-queues.

import { build856, build810 } from "./retailBuilders.js";
import { nextControlNumber } from "./outbox.js";

// Pull a normalized {name,address,city,state,zip,country} from a jsonb address
// blob (customer_locations.address / customers.shipping_address) — key names
// vary across the historical data, so read the common aliases leniently.
export function addrFromJson(j, name) {
  const a = (j && typeof j === "object") ? j : {};
  const first = (...keys) => { for (const k of keys) { const v = a[k]; if (v != null && String(v).trim() !== "") return String(v).trim(); } return null; };
  return {
    name: name || first("name", "company") || "",
    address: first("line1", "address1", "address", "street", "addr1"),
    city: first("city", "town"),
    state: first("state", "province", "region"),
    zip: first("zip", "postal_code", "postalCode", "postal", "zipcode"),
    country: first("country", "country_code") || "US",
    id: first("edi_id", "store_number", "dc_number") || null,
  };
}

// Resolve item id fields (sku / upc / gtin / description) for an invoice line.
function itemIdFields(itemRow) {
  if (!itemRow) return { sku: null, upc: null, gtin: null, description: null };
  const ext = (itemRow.external_refs && typeof itemRow.external_refs === "object") ? itemRow.external_refs : {};
  return {
    sku: itemRow.sku_code || null,
    upc: ext.upc || ext.UPC || ext.upc_a || null,
    gtin: ext.gtin || ext.gtin14 || ext.GTIN || null,
    description: itemRow.description || null,
  };
}

/**
 * Build the shipment + invoice domain objects for an AR invoice.
 * @returns {Promise<{ok, error?, invoice?, shipment?, partner?, customer_name?}>}
 */
export async function buildRetailContext(admin, { invoice }) {
  // Active retail partner for this customer.
  const { data: partner } = await admin
    .from("edi_customer_partners")
    .select("*")
    .eq("customer_id", invoice.customer_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!partner) return { ok: false, error: "no active EDI partner for customer" };

  const [{ data: customer }, { data: lines }, { data: company }] = await Promise.all([
    admin.from("customers").select("id, name, customer_code, code, shipping_address, billing_address").eq("id", invoice.customer_id).maybeSingle(),
    admin.from("ar_invoice_lines").select("line_number, description, inventory_item_id, quantity, unit_price_cents, line_total_cents").eq("ar_invoice_id", invoice.id).order("line_number", { ascending: true }),
    admin.from("company_settings").select("company_name, gs1_prefix, prefix_length, sscc_extension_digit").limit(1).maybeSingle(),
  ]);

  // Ship-to: prefer the invoice/SO ship-to location, else the customer default.
  let shipTo = null;
  const shipToLocId = invoice.ship_to_location_id;
  if (shipToLocId) {
    const { data: loc } = await admin.from("customer_locations").select("name, code, address").eq("id", shipToLocId).maybeSingle();
    if (loc) { shipTo = addrFromJson(loc.address, loc.name); if (loc.code) shipTo.id = shipTo.id || loc.code; }
  }
  if (!shipTo) shipTo = addrFromJson(customer?.shipping_address, customer?.name);

  // Resolve item ids for lines that carry an inventory item.
  const itemIds = [...new Set((lines || []).map((l) => l.inventory_item_id).filter(Boolean))];
  const itemMap = new Map();
  if (itemIds.length) {
    const { data: items } = await admin.from("ip_item_master").select("id, sku_code, description, external_refs").in("id", itemIds);
    for (const it of items || []) itemMap.set(it.id, it);
  }

  const buildLines = (lines || []).map((l, i) => {
    const idf = itemIdFields(itemMap.get(l.inventory_item_id));
    return {
      line: l.line_number || i + 1,
      qty: Number(l.quantity) || 0,
      unit: "EA",
      unit_price_cents: Number(l.unit_price_cents) || 0,
      line_total_cents: l.line_total_cents != null ? Number(l.line_total_cents) : null,
      description: idf.description || l.description || null,
      sku: idf.sku, upc: idf.upc, gtin: idf.gtin,
    };
  });

  const billTo = addrFromJson(customer?.billing_address, customer?.name);
  const remitTo = { name: company?.company_name || "Ring of Fire Clothing", id: partner.our_isa_id || null };
  const gs1 = {
    extension_digit: company?.sscc_extension_digit || "0",
    prefix: company?.gs1_prefix || "0000000",
  };

  const invoiceObj = {
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date || invoice.posting_date,
    po_number: null, // customer PO resolved below if a SO is linked
    ship_date: invoice.invoice_date || invoice.posting_date,
    currency: "USD",
    bill_to: billTo, ship_to: shipTo, remit_to: remitTo,
    lines: buildLines,
  };
  const shipmentObj = {
    shipment_id: invoice.shipment_id || invoice.invoice_number,
    ship_date: invoice.invoice_date || invoice.posting_date,
    po_number: null,
    invoice_number: invoice.invoice_number,
    ship_to: shipTo,
    ship_from: { name: company?.company_name || "Ring of Fire Clothing" },
    gs1,
    lines: buildLines,
  };

  // Customer PO from the linked sales order, if any.
  if (invoice.sales_order_id) {
    const { data: so } = await admin.from("sales_orders").select("customer_po, so_number, order_date").eq("id", invoice.sales_order_id).maybeSingle();
    const po = so?.customer_po || so?.so_number || null;
    invoiceObj.po_number = po; invoiceObj.po_date = so?.order_date || null;
    shipmentObj.po_number = po; shipmentObj.po_date = so?.order_date || null;
  }

  return { ok: true, partner, invoice: invoiceObj, shipment: shipmentObj, customer_name: customer?.name || null };
}

/**
 * Generate + queue the enabled retail docs for a posted AR invoice.
 * @param {object} admin  supabase service-role client
 * @param {object} opts
 * @param {object} opts.invoice   an ar_invoices row (must have id, customer_id…)
 * @param {string[]} [opts.docs]  restrict to a subset, e.g. ['856'] (default: partner.enabled_docs ∩ ['856','810'])
 * @param {Date}   [opts.now]
 * @returns {Promise<{ok, queued:Array, skipped?:string, error?:string}>}
 */
export async function enqueueRetailEdiForInvoice(admin, { invoice, docs = null, now = new Date() }) {
  if (!invoice || !invoice.id || !invoice.customer_id) return { ok: false, error: "invoice with id + customer_id required" };

  const ctx = await buildRetailContext(admin, { invoice });
  if (!ctx.ok) return { ok: true, queued: [], skipped: ctx.error };

  const partner = ctx.partner;
  const enabled = new Set(partner.enabled_docs || []);
  const wanted = (docs && docs.length ? docs : ["856", "810"]).filter((d) => enabled.has(d));
  if (wanted.length === 0) return { ok: true, queued: [], skipped: "no enabled retail docs (856/810) for partner" };

  const queued = [];
  let seed = Date.now();
  for (const doc of wanted) {
    const controlNumber = nextControlNumber(seed++);
    let built;
    try {
      built = doc === "856"
        ? build856({ shipment: ctx.shipment, partner, controlNumber, now })
        : build810({ invoice: ctx.invoice, partner, controlNumber, now });
    } catch (e) {
      queued.push({ doc, error: `build failed: ${e?.message || e}` });
      continue;
    }
    const filename = `${doc}_${invoice.invoice_number || invoice.id}_${controlNumber}.edi`;
    const parsed_content = {
      doc, invoice_number: invoice.invoice_number, customer: ctx.customer_name,
      ...(doc === "856" ? { ssccs: built.ssccs, single_pack: built.single_pack, hl_count: built.hl_count } : { totals: built.totals }),
    };
    const { data, error } = await admin.from("edi_messages").insert({
      direction: "outbound",
      transaction_set: doc,
      status: "queued",
      interchange_id: String(controlNumber),
      group_control_number: String(built.groupControlNumber ?? controlNumber),
      raw_content: built.x12,
      parsed_content,
      file_name: filename,
      edi_customer_partner_id: partner.id,
      ar_invoice_id: invoice.id,
      sales_order_id: invoice.sales_order_id || null,
      transmitted: false,
    }).select("id").maybeSingle();

    if (error) {
      // 23505 = the unique dedupe index — this doc is already queued for the invoice.
      if (error.code === "23505") { queued.push({ doc, skipped: "already queued for this invoice" }); continue; }
      queued.push({ doc, error: error.message });
      continue;
    }
    queued.push({ doc, id: data?.id, control_number: controlNumber, single_pack: doc === "856" ? built.single_pack : undefined });
  }
  return { ok: true, queued, partner_id: partner.id };
}
