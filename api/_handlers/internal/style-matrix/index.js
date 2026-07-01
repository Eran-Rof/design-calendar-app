// api/internal/style-matrix?style_id=<uuid>
//
// GET — the color × size (× inseam) matrix payload for one style: the scale's
// ordered sizes, the style's colors/inseams, and each SKU's on-hand/available.
// Shared by the matrix inventory view, SO entry, adjustments, and PO entry.

import { createClient } from "@supabase/supabase-js";
import { enumerateStyleMatrix } from "../../../_lib/styleMatrix.js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const styleId = req.query?.style_id;
  if (!styleId || !UUID_RE.test(String(styleId))) return res.status(400).json({ error: "style_id (uuid) required" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // Explode-PPK: opt-in. When true, the payload folds a SIZED style's PPK
  // sibling packs into per-size eaches (see _lib/styleMatrix.js). Off by default
  // so existing consumers (SO entry, adjustments, PO) are unaffected.
  const explodePpk = String(req.query?.explode_ppk || "").toLowerCase() === "true";

  // Lot filter (opt-in): `?lots=A,B` or repeated `?lots=A&lots=B`. When present,
  // on-hand is scoped to those lot numbers; the payload's `lots` list stays the
  // full set so the UI dropdown remains fully populated. Empty → all lots.
  const rawLots = req.query?.lots;
  const lotFilter = (Array.isArray(rawLots) ? rawLots : (rawLots != null ? String(rawLots).split(",") : []))
    .map((s) => String(s).trim())
    .filter(Boolean);

  const payload = await enumerateStyleMatrix(admin, eid, String(styleId), { explodePpk, lotFilter });
  if (!payload) return res.status(404).json({ error: "Style not found" });
  return res.status(200).json(payload);
}
