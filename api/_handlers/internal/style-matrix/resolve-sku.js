// api/internal/style-matrix/resolve-sku
//
// POST { style_id, color?, size, inseam? } → { id, created }
// Finds (or auto-creates) the ip_item_master SKU for one matrix cell, so the
// SO / adjustment / PO matrix-entry surfaces can map a cell to a SKU id on
// submit. Service-role; staff-internal.

import { createClient } from "@supabase/supabase-js";
import { resolveOrCreateSku } from "../../../_lib/styleMatrix.js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return null;
  return createClient(SB_URL, KEY, { auth: { persistSession: false } });
}
async function entityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body?.style_id || !UUID_RE.test(String(body.style_id))) return res.status(400).json({ error: "style_id (uuid) required" });
  if (!body?.size) return res.status(400).json({ error: "size required" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const out = await resolveOrCreateSku(admin, eid, {
    style_id: String(body.style_id), style_code: body.style_code || null,
    color: body.color || null, size: body.size, inseam: body.inseam || null,
  });
  if (out.error) return res.status(500).json({ error: out.error });
  return res.status(200).json(out);
}
