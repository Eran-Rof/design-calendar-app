// api/internal/procurement/broker-invoices/:id  (h595)
//
// P13-C3 — Trade Compliance vertical, single broker-invoice CRUD (data-only).
//
// GET    → header + embedded vendor name + linked customs entry_number.
// PATCH  → edit any field. When charge components are touched, total_cents is
//          re-validated/recomputed (>= the component sum, or computed from them).
// DELETE → removes the broker invoice.
//
// FINANCIALLY INERT: no AP invoice creation (ap_invoice_id stays NULL), no
// allocation JE (allocation_je_id stays NULL). Landed-cost allocation onto FIFO
// layers is owned by a separate chunk.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOCATION_METHODS = ["value", "weight", "cbm", "manual"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

function optCents(val, label) {
  if (val == null || val === "") return { v: 0 };
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative integer (cents)` };
  return { v: n };
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: inv, error: iErr } = await admin
    .from("broker_invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (iErr) return res.status(500).json({ error: iErr.message });
  if (!inv) return res.status(404).json({ error: "Broker invoice not found" });

  if (req.method === "GET") {
    let vendor_name = null, customs_entry_number = null;
    if (inv.vendor_id) {
      const { data: v } = await admin.from("vendors").select("name").eq("id", inv.vendor_id).maybeSingle();
      vendor_name = v ? v.name : null;
    }
    if (inv.customs_entry_id) {
      const { data: ce } = await admin.from("customs_entries").select("entry_number").eq("id", inv.customs_entry_id).maybeSingle();
      customs_entry_number = ce ? ce.entry_number : null;
    }
    return res.status(200).json({ ...inv, vendor_name, customs_entry_number });
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("broker_invoices").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const patch = {};
    if ("vendor_id" in body) {
      if (!body.vendor_id || !UUID_RE.test(String(body.vendor_id))) return res.status(400).json({ error: "vendor_id (uuid) required" });
      patch.vendor_id = body.vendor_id;
    }
    if ("broker_invoice_number" in body) {
      const n = body.broker_invoice_number ? String(body.broker_invoice_number).trim() : "";
      if (!n) return res.status(400).json({ error: "broker_invoice_number cannot be empty" });
      patch.broker_invoice_number = n;
    }
    if ("invoice_date" in body) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.invoice_date || ""))) {
        return res.status(400).json({ error: "invoice_date must be YYYY-MM-DD" });
      }
      patch.invoice_date = body.invoice_date;
    }
    if ("customs_entry_id" in body) {
      patch.customs_entry_id = body.customs_entry_id && UUID_RE.test(String(body.customs_entry_id)) ? body.customs_entry_id : null;
    }
    if ("allocation_method" in body) {
      const m = body.allocation_method ? String(body.allocation_method).trim() : "value";
      if (!ALLOCATION_METHODS.includes(m)) return res.status(400).json({ error: `allocation_method must be one of ${ALLOCATION_METHODS.join(", ")}` });
      patch.allocation_method = m;
    }

    // Charge components: validate each touched field; recompute total when any
    // component changes (or when total itself is supplied).
    const touchesComponent =
      "freight_cents" in body || "brokerage_fee_cents" in body || "duty_advance_cents" in body || "other_cents" in body;

    const freight = optCents("freight_cents" in body ? body.freight_cents : inv.freight_cents, "freight_cents");
    if (freight.error) return res.status(400).json({ error: freight.error });
    const brokerage = optCents("brokerage_fee_cents" in body ? body.brokerage_fee_cents : inv.brokerage_fee_cents, "brokerage_fee_cents");
    if (brokerage.error) return res.status(400).json({ error: brokerage.error });
    const dutyAdv = optCents("duty_advance_cents" in body ? body.duty_advance_cents : inv.duty_advance_cents, "duty_advance_cents");
    if (dutyAdv.error) return res.status(400).json({ error: dutyAdv.error });
    const other = optCents("other_cents" in body ? body.other_cents : inv.other_cents, "other_cents");
    if (other.error) return res.status(400).json({ error: other.error });

    if ("freight_cents" in body) patch.freight_cents = freight.v;
    if ("brokerage_fee_cents" in body) patch.brokerage_fee_cents = brokerage.v;
    if ("duty_advance_cents" in body) patch.duty_advance_cents = dutyAdv.v;
    if ("other_cents" in body) patch.other_cents = other.v;

    const componentSum = freight.v + brokerage.v + dutyAdv.v + other.v;
    if ("total_cents" in body && body.total_cents != null && body.total_cents !== "") {
      const t = optCents(body.total_cents, "total_cents");
      if (t.error) return res.status(400).json({ error: t.error });
      if (t.v < componentSum) {
        return res.status(400).json({ error: `total_cents (${t.v}) must be >= the sum of freight + brokerage + duty advance + other (${componentSum})` });
      }
      patch.total_cents = t.v;
    } else if (touchesComponent) {
      // Components changed without an explicit total — recompute to the sum.
      patch.total_cents = componentSum;
    }

    if (Object.keys(patch).length === 0) return res.status(200).json(inv);

    // Re-validate FK targets when changed.
    if (patch.vendor_id) {
      const { data: ven } = await admin.from("vendors").select("id, entity_id").eq("id", patch.vendor_id).maybeSingle();
      if (!ven || ven.entity_id !== inv.entity_id) return res.status(404).json({ error: "Vendor not found" });
    }
    if (patch.customs_entry_id) {
      const { data: ce } = await admin.from("customs_entries").select("id, entity_id").eq("id", patch.customs_entry_id).maybeSingle();
      if (!ce || ce.entity_id !== inv.entity_id) return res.status(404).json({ error: "Customs entry not found" });
    }

    const { error: uErr } = await admin.from("broker_invoices").update(patch).eq("id", id);
    if (uErr) {
      if (uErr.code === "23505") return res.status(409).json({ error: "Broker invoice number already exists for this vendor." });
      return res.status(500).json({ error: uErr.message });
    }

    const { data: fresh, error: fErr } = await admin.from("broker_invoices").select("*").eq("id", id).single();
    if (fErr) return res.status(500).json({ error: fErr.message });
    return res.status(200).json(fresh);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
