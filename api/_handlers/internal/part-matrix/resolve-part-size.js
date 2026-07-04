// api/internal/part-matrix/resolve-part-size
//
// POST { part_id (matrix parent), size } → { id, created }
// Find (or create) the per-size CHILD part for one matrix cell, so PO / BOM
// by-size entry can map a size to a real part id on submit. Mirrors
// /api/internal/style-matrix/resolve-sku for parts. Service-role; staff-internal.

import { createClient } from "@supabase/supabase-js";
import { resolveOrCreatePartSize } from "../../../_lib/partMatrix.js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
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
  if (!body?.part_id || !UUID_RE.test(String(body.part_id))) return res.status(400).json({ error: "part_id (uuid) required" });
  if (!body?.size) return res.status(400).json({ error: "size required" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const out = await resolveOrCreatePartSize(admin, eid, { parent_part_id: String(body.part_id), size: String(body.size) });
  if (out.error) return res.status(out.error === "parent part not found" ? 404 : 400).json({ error: out.error });
  return res.status(200).json(out);
}
