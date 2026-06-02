// api/internal/procurement/broker-invoices  (h594)
//
// P13-C3 — Trade Compliance vertical. Customs-broker invoices (freight,
// brokerage fees, duty advances, other charges) optionally tied to a customs
// entry. Draft / data-only CRUD.
//
// GET  ?limit=  → broker invoice headers for the default entity (newest first),
//      each embedding the vendor name + the linked customs entry_number.
// POST { vendor_id, broker_invoice_number, invoice_date, customs_entry_id?,
//        freight_cents?, brokerage_fee_cents?, duty_advance_cents?, other_cents?,
//        total_cents?, allocation_method? }
//      → inserts the broker invoice. total_cents, when supplied, must be >= the
//        sum of the component charges; when omitted it is COMPUTED from them.
//
// FINANCIALLY INERT: no AP invoice is created (ap_invoice_id stays NULL) and no
// allocation JE is posted (allocation_je_id stays NULL). The landed-cost
// allocation onto FIFO layers is owned by a separate chunk.
//
// Entity scoped. Writes via service-role (anon-read RLS).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOCATION_METHODS = ["value", "weight", "cbm", "manual"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data ? data.id : null;
}

const HEADER_COLS =
  "id, entity_id, customs_entry_id, vendor_id, broker_invoice_number, invoice_date, " +
  "freight_cents, brokerage_fee_cents, duty_advance_cents, other_cents, total_cents, " +
  "ap_invoice_id, allocation_method, allocation_je_id, created_at";

function optCents(val, label) {
  if (val == null || val === "") return { v: 0 };
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative integer (cents)` };
  return { v: n };
}

// Normalize + validate the POST body. Returns { error } or { data }.
function validateInsert(body) {
  if (!body || typeof body !== "object") return { error: "body required" };
  if (!body.vendor_id || !UUID_RE.test(String(body.vendor_id))) {
    return { error: "vendor_id (uuid) required" };
  }
  const invNumber = body.broker_invoice_number ? String(body.broker_invoice_number).trim() : "";
  if (!invNumber) return { error: "broker_invoice_number required" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.invoice_date || ""))) {
    return { error: "invoice_date (YYYY-MM-DD) required" };
  }

  const freight = optCents(body.freight_cents, "freight_cents");
  if (freight.error) return { error: freight.error };
  const brokerage = optCents(body.brokerage_fee_cents, "brokerage_fee_cents");
  if (brokerage.error) return { error: brokerage.error };
  const dutyAdv = optCents(body.duty_advance_cents, "duty_advance_cents");
  if (dutyAdv.error) return { error: dutyAdv.error };
  const other = optCents(body.other_cents, "other_cents");
  if (other.error) return { error: other.error };

  const componentSum = freight.v + brokerage.v + dutyAdv.v + other.v;
  let total = componentSum;
  if (body.total_cents != null && body.total_cents !== "") {
    const t = optCents(body.total_cents, "total_cents");
    if (t.error) return { error: t.error };
    if (t.v < componentSum) {
      return { error: `total_cents (${t.v}) must be >= the sum of freight + brokerage + duty advance + other (${componentSum})` };
    }
    total = t.v;
  }

  let method = body.allocation_method ? String(body.allocation_method).trim() : "value";
  if (!ALLOCATION_METHODS.includes(method)) {
    return { error: `allocation_method must be one of ${ALLOCATION_METHODS.join(", ")}` };
  }

  return {
    data: {
      vendor_id: body.vendor_id,
      broker_invoice_number: invNumber,
      invoice_date: body.invoice_date,
      customs_entry_id:
        body.customs_entry_id && UUID_RE.test(String(body.customs_entry_id)) ? body.customs_entry_id : null,
      freight_cents: freight.v,
      brokerage_fee_cents: brokerage.v,
      duty_advance_cents: dutyAdv.v,
      other_cents: other.v,
      total_cents: total,
      allocation_method: method,
      // ap_invoice_id + allocation_je_id intentionally omitted — left NULL.
    },
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 1000);

    const { data, error } = await admin
      .from("broker_invoices")
      .select(
        // Single-FK relationships to distinct tables — PostgREST resolves these
        // by table name without needing the constraint hint.
        HEADER_COLS +
          ", vendor:vendors(name)" +
          ", customs_entry:customs_entries(entry_number)",
      )
      .eq("entity_id", entityId)
      .order("invoice_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    const out = (data || []).map((row) => {
      const vendor = row.vendor || null;
      const ce = row.customs_entry || null;
      const { vendor: _v, customs_entry: _c, ...header } = row; // eslint-disable-line no-unused-vars
      return {
        ...header,
        vendor_name: vendor ? vendor.name : null,
        customs_entry_number: ce ? ce.entry_number : null,
      };
    });
    return res.status(200).json(out);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const v = validateInsert(body);
    if (v.error) return res.status(400).json({ error: v.error });

    // Validate FK targets belong to this entity (vendor required; customs entry optional).
    const { data: vendor, error: venErr } = await admin
      .from("vendors")
      .select("id, entity_id")
      .eq("id", v.data.vendor_id)
      .maybeSingle();
    if (venErr) return res.status(500).json({ error: venErr.message });
    if (!vendor || vendor.entity_id !== entityId) return res.status(404).json({ error: "Vendor not found" });

    if (v.data.customs_entry_id) {
      const { data: ce, error: ceErr } = await admin
        .from("customs_entries")
        .select("id, entity_id")
        .eq("id", v.data.customs_entry_id)
        .maybeSingle();
      if (ceErr) return res.status(500).json({ error: ceErr.message });
      if (!ce || ce.entity_id !== entityId) return res.status(404).json({ error: "Customs entry not found" });
    }

    const { data: header, error: hErr } = await admin
      .from("broker_invoices")
      .insert({
        // entity_id omitted — DB default rof_entity_id()
        ...v.data,
      })
      .select(HEADER_COLS)
      .single();
    if (hErr) {
      if (hErr.code === "23505") {
        return res.status(409).json({ error: `Broker invoice "${v.data.broker_invoice_number}" already exists for this vendor.` });
      }
      return res.status(500).json({ error: hErr.message });
    }

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
