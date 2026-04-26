// api/vendor/attachments/:id
//
// DELETE — soft-delete an attachment (sets deleted_at). RLS ensures the
//          caller can only remove their own vendor's rows.
// PATCH  body: { file_description?: string } — rename the description

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req, {});
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const { auth, finish } = authRes;
  const send = (code, payload) => { finish?.(code); return res.status(code).json(payload); };
  const id = getId(req);
  if (!id) return send(400, { error: "Missing attachment id" });

  // Ownership check
  const { data: row } = await admin
    .from("attachments").select("id, vendor_id, deleted_at").eq("id", id).maybeSingle();
  if (!row || row.vendor_id !== auth.vendor_id) return send(404, { error: "Not found" });

  if (req.method === "DELETE") {
    // Filter on vendor_id too — defense in depth in case the row's owner
    // changed between the read above and the update below.
    const { error } = await admin
      .from("attachments").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("vendor_id", auth.vendor_id);
    if (error) return send(500, { error: error.message });
    return send(200, { ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }
    const patch = { };
    if (body?.file_description !== undefined) patch.file_description = body.file_description ? String(body.file_description).trim() : null;
    if (Object.keys(patch).length === 0) return send(400, { error: "Nothing to update" });
    const { data, error } = await admin
      .from("attachments").update(patch).eq("id", id).eq("vendor_id", auth.vendor_id).select("*").single();
    if (error) return send(500, { error: error.message });
    return send(200, data);
  }

  return send(405, { error: "Method not allowed" });
}
