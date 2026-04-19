// api/edi/inbound
//
// POST — receive a raw X12 envelope from a vendor (AS2 gateway, SFTP
// puller cron, or direct upload). Body can be:
//   - Content-Type: text/plain or application/edi-x12 → raw body
//   - Content-Type: application/json → { vendor_id?, raw, interchange_id? }
//
// Pipeline:
//   1. Parse envelope
//   2. Resolve vendor_id via GS02 (partner ID) stored in
//      erp_integrations.config.partner_id, or via explicit vendor_id
//      in the JSON body
//   3. Store ONE edi_messages row per transaction set with parsed_content
//      jsonb
//   4. Run the matching mapper (855/856/810/997); write the outcome to
//      erp_sync_logs
//   5. Return a 997 acknowledgment envelope in the response body
//      (partner's AS2 stack will relay it back)
//
// This endpoint is public-facing; partners authenticate via a shared
// secret in X-EDI-Token (env: EDI_INBOUND_SHARED_SECRET).

import { createClient } from "@supabase/supabase-js";
import { parseEnvelope, interchangeControl, groupControl, transactionControl, el, segmentsByTag } from "../_lib/edi/parser.js";
import { build997 } from "../_lib/edi/builder.js";
import { map855, map856, map810, map997 } from "../_lib/edi/mappers.js";

export const config = { maxDuration: 60 };

async function resolveVendorFromGs(admin, gsSender, explicitVendorId) {
  if (explicitVendorId) {
    const { data } = await admin.from("vendors").select("id, name").eq("id", explicitVendorId).maybeSingle();
    return data;
  }
  if (!gsSender) return null;
  // Look for an ERP integration whose config.partner_id matches GS02.
  const { data: integrations } = await admin
    .from("erp_integrations")
    .select("vendor_id, config, status")
    .eq("status", "active");
  for (const row of integrations || []) {
    const pid = (row.config && (row.config.partner_id || row.config.edi_id || row.config.isa_id)) || "";
    if (pid && String(pid).trim() === String(gsSender).trim()) {
      const { data } = await admin.from("vendors").select("id, name").eq("id", row.vendor_id).maybeSingle();
      if (data) return data;
    }
  }
  return null;
}

async function readRawBody(req) {
  if (typeof req.body === "string" && req.body.length > 0) return req.body;
  if (req.body && typeof req.body === "object") {
    if (typeof req.body.raw === "string") return req.body.raw;
    return null;
  }
  // Node stream fallback
  return await new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c.toString(); });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-EDI-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SECRET = process.env.EDI_INBOUND_SHARED_SECRET;
  if (SECRET) {
    const token = req.headers["x-edi-token"];
    if (!token || token !== SECRET) return res.status(401).json({ error: "Invalid EDI token" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let raw = await readRawBody(req);
  let explicitVendorId = null;
  let explicitInterchangeId = null;
  if (typeof req.body === "object" && req.body) {
    if (req.body.vendor_id) explicitVendorId = req.body.vendor_id;
    if (req.body.interchange_id) explicitInterchangeId = req.body.interchange_id;
  }
  if (!raw || !raw.trim()) return res.status(400).json({ error: "Empty EDI body" });

  const envelope = parseEnvelope(raw);
  const isaCtl = interchangeControl(envelope.isa);
  const interchangeId = explicitInterchangeId || isaCtl.controlNumber;

  const results = [];
  for (const group of envelope.groups) {
    const gsCtl = groupControl(group.gs);
    const vendor = await resolveVendorFromGs(admin, gsCtl.sender, explicitVendorId);
    if (!vendor) {
      results.push({ group: gsCtl, error: `Could not resolve vendor (GS02 sender=${gsCtl.sender})`, accepted: false });
      continue;
    }

    for (const txn of group.transactions) {
      const stCtl = transactionControl(txn.st);
      const set = stCtl.transactionSet;

      const parsedContent = {
        interchange: isaCtl,
        group: gsCtl,
        transaction: stCtl,
        segments: txn.segments.map((s) => ({ tag: (s[0] || "").toUpperCase(), elements: s.slice(1) })),
      };

      const { data: msg, error: msgErr } = await admin.from("edi_messages").insert({
        vendor_id: vendor.id,
        direction: "inbound",
        transaction_set: set,
        interchange_id: interchangeId,
        status: "received",
        raw_content: raw,
        parsed_content: parsedContent,
      }).select("id").single();
      if (msgErr) {
        results.push({ group: gsCtl, transaction: stCtl, error: msgErr.message, accepted: false });
        continue;
      }

      let mapped = null;
      if (set === "855") mapped = await map855({ segments: txn.segments, admin, vendor_id: vendor.id });
      else if (set === "856") mapped = await map856({ segments: txn.segments, admin, vendor_id: vendor.id });
      else if (set === "810") mapped = await map810({ segments: txn.segments, admin, vendor_id: vendor.id });
      else if (set === "997") mapped = await map997({ segments: txn.segments });
      else mapped = { ok: false, error: `Unsupported inbound transaction set: ${set}` };

      const logRow = {
        integration_id: null,
        direction: "inbound",
        entity_type: mapped?.entity_type === "po" ? "po"
                   : mapped?.entity_type === "shipment" ? "shipment"
                   : mapped?.entity_type === "invoice" ? "invoice"
                   : "po",
        entity_id: mapped?.entity_id || null,
        status: mapped?.ok ? "success" : (mapped?.duplicate ? "skipped" : "error"),
        payload_hash: `${interchangeId}-${gsCtl.controlNumber}-${stCtl.controlNumber}`,
        error_message: mapped?.ok ? null : (mapped?.error || null),
      };
      const { data: integration } = await admin.from("erp_integrations").select("id").eq("vendor_id", vendor.id).eq("status", "active").maybeSingle();
      if (integration) logRow.integration_id = integration.id;
      if (logRow.integration_id) await admin.from("erp_sync_logs").insert(logRow);

      await admin.from("edi_messages").update({
        status: mapped?.ok ? "processed" : "error",
        error_message: mapped?.ok ? null : (mapped?.error || null),
        updated_at: new Date().toISOString(),
      }).eq("id", msg.id);

      results.push({ group: gsCtl, transaction: stCtl, mapped, accepted: !!mapped?.ok });
    }
  }

  // Produce a single 997 ACK per inbound envelope, spanning all groups.
  // Keep it simple: one AK1 per group, aggregated accepted count.
  const ackForFirstGroup = envelope.groups[0] ? groupControl(envelope.groups[0].gs) : null;
  const ack = ackForFirstGroup ? build997({
    sender:    isaCtl.receiver || "RINGOFFIRE",
    receiver:  isaCtl.sender   || "VENDOR",
    controlNumber: Math.floor(Date.now() / 1000) % 1_000_000_000,
    ackForGroup: { functionalId: ackForFirstGroup.functionalId, controlNumber: ackForFirstGroup.controlNumber },
    ackForControl: isaCtl.controlNumber,
    accepted: results.every((r) => r.accepted),
  }) : null;

  // Store the outbound 997 as well
  if (ack && envelope.groups[0]) {
    const vendorOfFirst = await resolveVendorFromGs(admin, ackForFirstGroup.sender, explicitVendorId);
    if (vendorOfFirst) {
      await admin.from("edi_messages").insert({
        vendor_id: vendorOfFirst.id,
        direction: "outbound",
        transaction_set: "997",
        interchange_id: interchangeId,
        status: "acknowledged",
        raw_content: ack,
      });
    }
  }

  res.setHeader("Content-Type", "application/edi-x12");
  return res.status(200).send(ack || "");
}
