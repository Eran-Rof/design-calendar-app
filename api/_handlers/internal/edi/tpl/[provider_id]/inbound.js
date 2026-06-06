// api/internal/edi/tpl/:provider_id/inbound
//
// INBOUND ack path for 3PL warehouse EDI. Receives an X12 945 (Warehouse
// Shipping Advice) from the 3PL provider confirming what actually shipped
// against a 940 we sent, plus carrier + tracking. On receipt it:
//   1. stores the raw 945 in edi_messages (transaction_set '945', inbound),
//   2. resolves the tpl_shipment by shipment_number from the 945 (W06),
//   3. advances that shipment to 'shipped' + records carrier/tracking.
//
// This is the RETURN leg of the wave → 940 → 3PL → 945 round-trip. Parsing is
// minimal but structured (see parse945 in api/_lib/edi/builder.js); full segment
// coverage (line-level partials, backorders) is a follow-up.
//
// POST body: raw X12 string, or { raw: "<X12>" }, or already-parsed
//            { shipment_number, carrier?, tracking_number?, lines? } for testing.
//
// 200: { ok, tpl_shipment_id?, edi_945_message_id, parsed }

import { createClient } from "@supabase/supabase-js";
import { parse945 } from "../../../../../_lib/edi/builder.js";
import { parseEnvelope } from "../../../../../_lib/edi/parser.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
async function readRaw(req) {
  if (typeof req.body === "string" && req.body.length) return req.body;
  if (req.body && typeof req.body === "object" && typeof req.body.raw === "string") return req.body.raw;
  return null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const providerId = getProviderId(req);
  if (!providerId || !UUID_RE.test(String(providerId))) return res.status(400).json({ error: "Invalid provider id" });

  const { data: provider } = await admin.from("tpl_providers").select("id, name, entity_id").eq("id", providerId).maybeSingle();
  if (!provider) return res.status(404).json({ error: "3PL provider not found" });

  // Parse the 945 — accept raw X12 or an already-parsed test body.
  let parsed = null;
  let raw = await readRaw(req);
  if (raw) {
    try {
      const env = parseEnvelope(raw);
      const txn = env.groups?.[0]?.transactions?.[0];
      const segments = (txn?.segments || []).map((s) => s);
      parsed = parse945(segments);
    } catch (e) {
      return res.status(400).json({ error: `Could not parse 945 envelope: ${e?.message || e}` });
    }
  } else {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    if (body.shipment_number) {
      parsed = {
        shipment_number: String(body.shipment_number),
        carrier: body.carrier || null,
        tracking_number: body.tracking_number || null,
        lines: Array.isArray(body.lines) ? body.lines : [],
      };
      raw = JSON.stringify(body);
    }
  }
  if (!parsed || !parsed.shipment_number) {
    return res.status(400).json({ error: "945 missing a shipment reference (W06 depositor order number)" });
  }

  // Resolve the tpl_shipment this 945 confirms.
  const { data: shipment } = await admin
    .from("tpl_shipments")
    .select("id, status, sales_order_id")
    .eq("tpl_provider_id", provider.id)
    .eq("shipment_number", parsed.shipment_number)
    .maybeSingle();

  // Store the inbound 945 regardless (so unmatched advices are still auditable).
  const { data: msg, error: msgErr } = await admin.from("edi_messages").insert({
    vendor_id: null,
    direction: "inbound",
    transaction_set: "945",
    status: shipment ? "processed" : "received",
    raw_content: raw,
    parsed_content: parsed,
    tpl_shipment_id: shipment?.id || null,
    sales_order_id: shipment?.sales_order_id || null,
    tpl_provider_id: provider.id,
  }).select("id").single();
  if (msgErr) return res.status(500).json({ error: `945 store failed: ${msgErr.message}` });

  if (!shipment) {
    return res.status(200).json({
      ok: false,
      edi_945_message_id: msg.id,
      parsed,
      message: `945 stored but no matching released 3PL shipment '${parsed.shipment_number}' for ${provider.name}. Review manually.`,
    });
  }

  // Advance the shipment to 'shipped' + record carrier/tracking.
  const patch = { status: "shipped", updated_at: new Date().toISOString() };
  if (parsed.carrier) patch.carrier = parsed.carrier;
  if (parsed.tracking_number) patch.tracking_number = parsed.tracking_number;
  patch.ship_date = new Date().toISOString().slice(0, 10);
  await admin.from("tpl_shipments").update(patch).eq("id", shipment.id);

  return res.status(200).json({
    ok: true,
    tpl_shipment_id: shipment.id,
    edi_945_message_id: msg.id,
    parsed,
    message: `945 received — 3PL shipment ${parsed.shipment_number} marked shipped${parsed.tracking_number ? ` (tracking ${parsed.tracking_number})` : ""}.`,
  });
}
