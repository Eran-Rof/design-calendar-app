// api/edi/inbound
//
// POST — receive a raw X12 envelope from a vendor. Vendor is resolved
// from GS02 against erp_integrations.config.partner_id, or from an
// explicit vendor_id in a JSON body.
//
// For a vendor-pinned variant (AS2 partner ID in the URL path), see
// /api/edi/inbound/:vendor_id.
//
// Auth: X-EDI-Token shared secret (env EDI_INBOUND_SHARED_SECRET).

import { createClient } from "@supabase/supabase-js";
import { processInboundEdi, readRawBody } from "../../_lib/edi/pipeline.js";

export const config = { maxDuration: 60 };

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

  const raw = await readRawBody(req);
  let pinnedVendorId = null;
  let interchangeIdOverride = null;
  if (req.body && typeof req.body === "object") {
    if (req.body.vendor_id) pinnedVendorId = req.body.vendor_id;
    if (req.body.interchange_id) interchangeIdOverride = req.body.interchange_id;
  }

  const result = await processInboundEdi({ admin, raw, pinnedVendorId, interchangeIdOverride, strictSenderCheck: false });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error });

  res.setHeader("Content-Type", "application/edi-x12");
  return res.status(200).send(result.ack || "");
}
