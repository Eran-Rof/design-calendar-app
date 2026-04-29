// api/edi/inbound/:vendor_id
//
// POST — vendor-pinned inbound endpoint. The vendor is identified by
// the URL path, and GS02 must match that vendor's erp_integration
// partner_id — mismatches are rejected in the per-group result.
//
// Shape is the same as /api/edi/inbound: body is raw X12 or JSON with
// { raw, interchange_id? }. Responds with a 997 envelope.
//
// Auth: X-EDI-Token shared secret (env EDI_INBOUND_SHARED_SECRET).

import { createClient } from "@supabase/supabase-js";
import { processInboundEdi, readRawBody } from "../../../_lib/edi/pipeline.js";

export const config = { maxDuration: 60 };

function getVendorId(req) {
  if (req.query && req.query.vendor_id) return req.query.vendor_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("inbound");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-EDI-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Fail closed — see /api/_handlers/edi/inbound/index.js for rationale.
  const SECRET = process.env.EDI_INBOUND_SHARED_SECRET;
  if (!SECRET) {
    return res.status(500).json({ error: "EDI_INBOUND_NOT_CONFIGURED" });
  }
  const token = req.headers["x-edi-token"];
  if (!token || token !== SECRET) {
    return res.status(401).json({ error: "Invalid EDI token" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const vendorId = getVendorId(req);
  if (!vendorId) return res.status(400).json({ error: "Missing vendor_id in URL" });

  const { data: vendor } = await admin.from("vendors").select("id").eq("id", vendorId).maybeSingle();
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  const raw = await readRawBody(req);
  let interchangeIdOverride = null;
  if (req.body && typeof req.body === "object" && req.body.interchange_id) interchangeIdOverride = req.body.interchange_id;

  const origin = `https://${req.headers.host}`;
  const result = await processInboundEdi({
    admin, raw,
    pinnedVendorId: vendorId,
    interchangeIdOverride,
    strictSenderCheck: true,
    origin,
  });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error });

  res.setHeader("Content-Type", "application/edi-x12");
  return res.status(200).send(result.ack || "");
}
