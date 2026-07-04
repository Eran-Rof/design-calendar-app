// api/internal/part-matrix
//
// GET ?part_id=<matrix parent> → { part, sizes, children:[{id,size,code,on_hand_qty,avg_cost_cents}] }
// The by-size matrix for a matrix (size-scaled) part — sizes from its size scale,
// plus each per-size child's on-hand. Mirrors /api/internal/style-matrix for parts.

import { createClient } from "@supabase/supabase-js";
import { enumeratePartMatrix } from "../../../_lib/partMatrix.js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const partId = (url.searchParams.get("part_id") || "").trim();
  if (!partId || !UUID_RE.test(partId)) return res.status(400).json({ error: "part_id (uuid) required" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const out = await enumeratePartMatrix(admin, eid, partId);
  if (out.error) return res.status(out.error === "part not found" ? 404 : 500).json({ error: out.error });
  return res.status(200).json(out);
}
