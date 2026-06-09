// api/internal/pim/style-thumbs
//
// POST { style_ids: string[] } → { [styleId]: { default: url|null, byColor: {colorLower: url} } }
//
// Batch primary-thumbnail lookup for a set of styles, so any "styles view" can
// show a small image per row in ONE request (instead of N). Returns signed
// thumb URLs (1h TTL). Same image source as the PIM images endpoint; mirrors
// the Inventory Matrix per-color thumbnail map (color → url, plus a default).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const BUCKET = "pim-images";
const TTL = 3600;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const ids = Array.isArray(body?.style_ids) ? body.style_ids.filter((s) => typeof s === "string" && s).slice(0, 500) : [];
  if (ids.length === 0) return res.status(200).json({});

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Primary first, then sort order — first row per (style,color) wins.
  const { data: rows, error } = await admin
    .from("product_images")
    .select("style_id, color, is_primary, sort_order, storage_path_thumb, storage_path_web")
    .in("style_id", ids)
    .order("is_primary", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  // Collect distinct paths and batch-sign them.
  const paths = [];
  const seenPath = new Set();
  for (const r of rows || []) {
    const p = r.storage_path_thumb || r.storage_path_web;
    if (p && !seenPath.has(p)) { seenPath.add(p); paths.push(p); }
  }
  const signedByPath = new Map();
  if (paths.length > 0) {
    const { data: signed } = await admin.storage.from(BUCKET).createSignedUrls(paths, TTL);
    for (const s of signed || []) if (s && !s.error && s.signedUrl) signedByPath.set(s.path, s.signedUrl);
  }

  const out = {};
  for (const id of ids) out[id] = { default: null, byColor: {} };
  for (const r of rows || []) {
    const p = r.storage_path_thumb || r.storage_path_web;
    const url = p ? signedByPath.get(p) : null;
    if (!url) continue;
    const slot = out[r.style_id];
    if (!slot) continue;
    if (!slot.default) slot.default = url;
    const key = (r.color || "").toLowerCase().trim();
    if (key && !slot.byColor[key]) slot.byColor[key] = url;
  }

  return res.status(200).json(out);
}
