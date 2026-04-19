// api/_lib/edi/mappers.js
//
// Map parsed X12 transactions to internal entities.
//
// Each mapper receives { segments, admin, vendor_id } and returns
// { ok, entity_type, entity_id, error? }.
//
// Mappers intentionally call the same service-role Supabase client as
// portal submissions so they go through the same validation paths (RLS
// is bypassed by service_role but CHECK constraints and FKs apply).

import { segmentsByTag, el } from "./parser.js";

// ─── 855 Purchase Order Acknowledgment ───────────────────────────────────
// BAK*00*AC*PONUMBER*20260419  — AC = acknowledged with changes, AT = accepted
export async function map855({ segments, admin, vendor_id }) {
  const [bak] = segmentsByTag(segments, "BAK");
  if (!bak) return { ok: false, error: "Missing BAK segment" };
  const poNumber = el(bak, 3);
  if (!poNumber) return { ok: false, error: "BAK03 (PO number) missing" };

  const { data: po } = await admin
    .from("tanda_pos")
    .select("uuid_id, vendor_id, po_number")
    .eq("po_number", poNumber)
    .eq("vendor_id", vendor_id)
    .maybeSingle();
  if (!po) return { ok: false, error: `PO ${poNumber} not found for this vendor` };

  // Look up or create primary vendor_user to attribute the acknowledgment.
  const { data: vu } = await admin
    .from("vendor_users")
    .select("id")
    .eq("vendor_id", vendor_id)
    .eq("role", "primary")
    .maybeSingle();
  if (!vu) return { ok: false, error: "No primary vendor_user to attribute acknowledgment" };

  await admin.from("po_acknowledgments").upsert(
    { po_number: poNumber, vendor_user_id: vu.id },
    { onConflict: "po_number,vendor_user_id" },
  );
  return { ok: true, entity_type: "po", entity_id: po.uuid_id, po_number: poNumber };
}

// ─── 856 Advance Ship Notice ─────────────────────────────────────────────
// BSN*00*SHIPID*20260419*HHMM
// HL loops describe shipment/order/pack/item hierarchy.
// REF*IA*<po_number>  or find PO by context
// TD1*CTN25*QTY*****G*WEIGHT*LB
// TD3*TL*SCAC*TRAILER  (carrier)
export async function map856({ segments, admin, vendor_id }) {
  const [bsn] = segmentsByTag(segments, "BSN");
  if (!bsn) return { ok: false, error: "Missing BSN segment" };
  const asnNumber = el(bsn, 2);

  // Find the first PO reference
  const refs = segmentsByTag(segments, "REF").filter((s) => ["PO", "IA"].includes(el(s, 1)));
  const poNumber = refs.length > 0 ? el(refs[0], 2) : null;
  if (!poNumber) return { ok: false, error: "Could not find PO reference in REF segments" };

  const { data: po } = await admin
    .from("tanda_pos")
    .select("uuid_id, po_number")
    .eq("po_number", poNumber)
    .eq("vendor_id", vendor_id)
    .maybeSingle();
  if (!po) return { ok: false, error: `PO ${poNumber} not found for this vendor` };

  const [td1] = segmentsByTag(segments, "TD1");
  const [td3] = segmentsByTag(segments, "TD3");
  const [td5] = segmentsByTag(segments, "TD5");
  const [dtm] = segmentsByTag(segments, "DTM").filter((s) => el(s, 1) === "011" || el(s, 1) === "067");

  const carrier = td5 ? el(td5, 5) : (td3 ? el(td3, 2) : null);
  const shipDate = dtm ? formatEdiDate(el(dtm, 2)) : null;
  const weight = td1 ? el(td1, 7) : null;

  const { data: ship, error } = await admin.from("shipments").insert({
    vendor_id,
    po_id: po.uuid_id,
    po_number: po.po_number,
    asn_number: asnNumber || null,
    carrier: carrier || null,
    ship_date: shipDate,
    workflow_status: "submitted",
    notes: weight ? `Gross weight ${weight}` : null,
  }).select("id").single();
  if (error) return { ok: false, error: error.message };

  return { ok: true, entity_type: "shipment", entity_id: ship.id };
}

// ─── 810 Invoice ────────────────────────────────────────────────────────
// BIG*20260419*INVNUM**PONUM
// N1*BY*BILL_TO_NAME
// REF*IA*VENDOR_ID
// IT1 loops for line items
// TDS*total_cents
// CTT*line_count
export async function map810({ segments, admin, vendor_id }) {
  const [big] = segmentsByTag(segments, "BIG");
  if (!big) return { ok: false, error: "Missing BIG segment" };
  const invNumber = el(big, 2);
  const poNumber = el(big, 4);
  if (!invNumber) return { ok: false, error: "BIG02 (invoice number) missing" };
  if (!poNumber)  return { ok: false, error: "BIG04 (PO number) missing" };

  const { data: po } = await admin
    .from("tanda_pos")
    .select("uuid_id")
    .eq("po_number", poNumber)
    .eq("vendor_id", vendor_id)
    .maybeSingle();
  if (!po) return { ok: false, error: `PO ${poNumber} not found for this vendor` };

  const invoiceDate = formatEdiDate(el(big, 1)) || new Date().toISOString().slice(0, 10);

  // TDS01 is total in whole cents (per X12 810 spec)
  const [tds] = segmentsByTag(segments, "TDS");
  const totalCents = tds ? Number(el(tds, 1)) || 0 : 0;
  const total = totalCents / 100;

  const { data: inv, error: invErr } = await admin.from("invoices").insert({
    vendor_id,
    po_id: po.uuid_id,
    invoice_number: invNumber,
    invoice_date: invoiceDate,
    currency: "USD",
    subtotal: total,
    total,
    tax: 0,
    status: "submitted",
    notes: "Received via EDI 810",
  }).select("id").single();
  if (invErr) {
    if (invErr.code === "23505") return { ok: false, error: `Invoice ${invNumber} already exists for this vendor`, duplicate: true };
    return { ok: false, error: invErr.message };
  }

  // IT1 loops
  const it1s = segmentsByTag(segments, "IT1");
  if (it1s.length > 0) {
    const lineRows = it1s.map((it1, idx) => ({
      invoice_id: inv.id,
      line_index: Number(el(it1, 1)) || idx + 1,
      description: null,
      quantity_invoiced: Number(el(it1, 2)) || 0,
      unit_price: Number(el(it1, 4)) || 0,
      line_total: (Number(el(it1, 2)) || 0) * (Number(el(it1, 4)) || 0),
    }));
    await admin.from("invoice_line_items").insert(lineRows);
  }

  return { ok: true, entity_type: "invoice", entity_id: inv.id };
}

// ─── 997 Functional Acknowledgment ──────────────────────────────────────
// Logged only — confirms partner received our outbound transaction.
// AK1*<group_fn_id>*<group_control_number>
// AK9*A|R*<n txn>*<n received>*<n accepted>
export async function map997({ segments }) {
  const [ak1] = segmentsByTag(segments, "AK1");
  const [ak9] = segmentsByTag(segments, "AK9");
  if (!ak1 || !ak9) return { ok: false, error: "Missing AK1 or AK9" };
  const accepted = el(ak9, 1) === "A";
  const groupControlNumber = el(ak1, 2);
  return { ok: true, entity_type: "ack", group_control_number: groupControlNumber, accepted };
}

function formatEdiDate(s) {
  if (!s) return null;
  const trimmed = String(s).replace(/\D/g, "");
  if (trimmed.length === 8) return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  if (trimmed.length === 6) return `20${trimmed.slice(0, 2)}-${trimmed.slice(2, 4)}-${trimmed.slice(4, 6)}`;
  return null;
}
