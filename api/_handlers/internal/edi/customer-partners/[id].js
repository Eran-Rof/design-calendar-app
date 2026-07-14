// api/internal/edi/customer-partners/[id]
//
// GET    — fetch a single edi_customer_partners row (customer NAME joined; the
//          SFTP secret is scrubbed, replaced by an edi_secret_set flag).
// PATCH  — update mutable fields (envelope ids, transport, enabled_docs, doc_map,
//          usage_indicator, write-only edi_secret, is_active…). id/entity_id/
//          customer_id are LOCKED.
// DELETE — hard-delete the trading-partner config.
// POST   — operator actions on this partner:
//            { action: "test" }                       → SFTP test connection
//            { action: "preview",  invoice_id }        → build 856/810 X12 (no write)
//            { action: "generate", invoice_id, docs? } → generate + QUEUE 856/810
//
// Tangerine — retailer-facing EDI. req.query.id per dispatcher convention.

import { createClient } from "@supabase/supabase-js";
import { testConnection } from "../../../../_lib/edi/transport.js";
import { build856, build810 } from "../../../../_lib/edi/retailBuilders.js";
import { buildRetailContext, enqueueRetailEdiForInvoice } from "../../../../_lib/edi/retailEnqueue.js";
import { pickRetailFields, scrubPartner } from "./index.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCKED_FIELDS = new Set(["id", "entity_id", "customer_id"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function customerName(admin, customerId) {
  if (!customerId) return { name: "", code: "" };
  const { data } = await admin
    .from("customers")
    .select("name, customer_code, code")
    .eq("id", customerId)
    .maybeSingle();
  return { name: data?.name || "", code: data?.customer_code || data?.code || "" };
}

async function loadInvoice(admin, invoiceId) {
  if (!invoiceId || !UUID_RE.test(String(invoiceId))) return null;
  const { data } = await admin.from("ar_invoices").select("*").eq("id", invoiceId).maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin.from("edi_customer_partners").select("*").eq("id", id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "EDI customer partner not found" });
    const c = await customerName(admin, data.customer_id);
    return res.status(200).json({ ...scrubPartner(data), customer_name: c.name, customer_code: c.code });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    for (const f of Object.keys(body)) {
      if (LOCKED_FIELDS.has(f)) return res.status(400).json({ error: `${f} is locked post-creation and cannot be updated` });
    }
    const patch = pickRetailFields(body);
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No mutable fields supplied" });
    const { data, error } = await admin.from("edi_customer_partners").update(patch).eq("id", id).select().single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "EDI customer partner not found" });
      return res.status(500).json({ error: error.message });
    }
    const c = await customerName(admin, data.customer_id);
    return res.status(200).json({ ...scrubPartner(data), customer_name: c.name, customer_code: c.code });
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin.from("edi_customer_partners").delete().eq("id", id).select("id").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "EDI customer partner not found" });
    return res.status(200).json({ deleted: true, id });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const action = String(body.action || "");

    const { data: partner } = await admin.from("edi_customer_partners").select("*").eq("id", id).maybeSingle();
    if (!partner) return res.status(404).json({ error: "EDI customer partner not found" });

    if (action === "test") {
      const result = await testConnection(partner);
      return res.status(200).json({ ok: result.ok, detail: result.detail, dirs: result.dirs || null });
    }

    if (action === "preview" || action === "generate") {
      const invoice = await loadInvoice(admin, body.invoice_id);
      if (!invoice) return res.status(400).json({ error: "invoice_id (uuid of an AR invoice) required" });
      if (invoice.customer_id !== partner.customer_id) {
        return res.status(409).json({ error: "Invoice belongs to a different customer than this EDI partner" });
      }
      if (action === "preview") {
        const ctx = await buildRetailContext(admin, { invoice });
        if (!ctx.ok) return res.status(409).json({ error: ctx.error });
        const enabled = new Set(partner.enabled_docs || []);
        const out = {};
        if (enabled.has("856")) { const b = build856({ shipment: ctx.shipment, partner, controlNumber: 1 }); out["856"] = { x12: b.x12, ssccs: b.ssccs, single_pack: b.single_pack, hl_count: b.hl_count }; }
        if (enabled.has("810")) { const b = build810({ invoice: ctx.invoice, partner, controlNumber: 1 }); out["810"] = { x12: b.x12, totals: b.totals }; }
        return res.status(200).json({ ok: true, preview: out, customer: ctx.customer_name });
      }
      // generate
      const docs = Array.isArray(body.docs) && body.docs.length ? body.docs.map(String) : null;
      const result = await enqueueRetailEdiForInvoice(admin, { invoice, docs });
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "Unsupported action (test | preview | generate)" });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
