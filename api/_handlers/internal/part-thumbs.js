// api/internal/part-thumbs
//
// POST { part_ids: string[] } → { [partId]: url|null }
//
// Batch primary-thumbnail lookup for a set of parts, so any "parts view" (Part
// Master list, BOM editor, build detail) can show a small image per row in ONE
// request instead of N. Returns signed thumb URLs (1h TTL) from the same
// pim-images bucket the PIM/part-image uploaders write to. Mirrors style-thumbs.

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
  const ids = Array.isArray(body?.part_ids) ? body.part_ids.filter((s) => typeof s === "string" && s).slice(0, 500) : [];
  if (ids.length === 0) return res.status(200).json({});

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Primary first, then sort order — first row per part wins.
  const { data: rows, error } = await admin
    .from("part_images")
    .select("part_id, is_primary, sort_order, storage_path_thumb, storage_path_web")
    .in("part_id", ids)
    .order("is_primary", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

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
  for (const id of ids) out[id] = null;
  for (const r of rows || []) {
    if (out[r.part_id]) continue; // first (primary) row wins
    const p = r.storage_path_thumb || r.storage_path_web;
    const url = p ? signedByPath.get(p) : null;
    if (url) out[r.part_id] = url;
  }

  return res.status(200).json(out);
}
