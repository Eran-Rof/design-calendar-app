// api/vendor/attachments
//
// GET  ?entity_type=...&entity_id=...  — list non-deleted attachments
// POST body: { entity_type, entity_id, file_url, file_description?, filename? }
//      — record a file uploaded to Supabase Storage as an attachment
//
// Entity_type is the same enum the DB CHECK uses. entity_id ownership
// is trusted based on RLS + the vendor check for each entity type.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";

export const config = { maxDuration: 10 };

const ENTITY_OWNER_QUERY = {
  invoice:             { table: "invoices",              id: "id", vendor: "vendor_id" },
  shipment:            { table: "shipments",             id: "id", vendor: "vendor_id" },
  po:                  { table: "tanda_pos",             id: "uuid_id", vendor: "vendor_id" },
  po_message:          { table: "po_messages",           id: "id", vendor: null },
  dispute:             { table: "disputes",              id: "id", vendor: "vendor_id" },
  contract:            { table: "vendor_contracts",      id: "id", vendor: "vendor_id" },
  compliance_document: { table: "compliance_documents",  id: "id", vendor: "vendor_id" },
  rfq_quote:           { table: "rfq_quotes",            id: "id", vendor: "vendor_id" },
  bulk_operation:      { table: "vendor_bulk_operations",id: "id", vendor: "vendor_id" },
};

async function verifyOwnership(admin, entityType, entityId, vendorId) {
  const meta = ENTITY_OWNER_QUERY[entityType];
  if (!meta) return false;
  if (!meta.vendor) return true; // po_message: trust RLS via caller
  const { data } = await admin
    .from(meta.table).select(meta.id + "," + meta.vendor)
    .eq(meta.id, entityId).maybeSingle();
  return !!data && data[meta.vendor] === vendorId;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req, {});
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const { auth, finish } = authRes;
  const vendorId = auth.vendor_id;
  const send = (code, payload) => { finish?.(code); return res.status(code).json(payload); };

  if (req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const entityType = url.searchParams.get("entity_type");
    const entityId = url.searchParams.get("entity_id");
    if (!entityType || !entityId) return send(400, { error: "entity_type and entity_id are required" });
    if (!ENTITY_OWNER_QUERY[entityType]) return send(400, { error: `Unknown entity_type: ${entityType}` });

    const ok = await verifyOwnership(admin, entityType, entityId, vendorId);
    if (!ok) return send(403, { error: "Not yours" });

    const { data, error } = await admin
      .from("attachments")
      .select("id, file_url, file_description, filename, uploaded_at, uploaded_by_auth_id")
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .is("deleted_at", null)
      .order("uploaded_at", { ascending: true });
    if (error) return send(500, { error: error.message });
    return send(200, { rows: data || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }
    const { entity_type, entity_id, file_url, file_description, filename } = body || {};
    if (!entity_type || !entity_id || !file_url) {
      return send(400, { error: "entity_type, entity_id, and file_url are required" });
    }
    if (!ENTITY_OWNER_QUERY[entity_type]) return send(400, { error: `Unknown entity_type: ${entity_type}` });

    const ok = await verifyOwnership(admin, entity_type, entity_id, vendorId);
    if (!ok) return send(403, { error: "Not yours" });

    const { data, error } = await admin.from("attachments").insert({
      entity_type, entity_id,
      vendor_id: vendorId,
      file_url,
      file_description: file_description ? String(file_description).trim() : null,
      filename: filename ? String(filename).trim() : null,
      uploaded_by_auth_id: auth.auth_id || null,
    }).select("*").single();
    if (error) return send(500, { error: error.message });
    return send(201, data);
  }

  return send(405, { error: "Method not allowed" });
}
