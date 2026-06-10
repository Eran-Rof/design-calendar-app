// api/internal/pim/style-thumbs-by-code
//
// POST { style_codes: string[] }
//   → { [STYLE_CODE_UPPER]: { style_id, default: url|null, byColor: {colorLower: url} } }
//
// Same primary-thumbnail lookup as style-thumbs.js, but keyed by style CODE
// instead of style_master.id. The ATS app works off ip_item_master style
// codes (not style_master uuids), so it can't call style-thumbs directly —
// this resolves each code → style_master.id first, then runs the same
// product_images query. The returned `style_id` lets the caller open the
// full image gallery (which is keyed by uuid).
//
// Returns signed thumb URLs (1h TTL). Read-only; ungated like style-thumbs.

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
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
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
  const codes = Array.isArray(body?.style_codes)
    ? Array.from(new Set(
        body.style_codes
          .filter((s) => typeof s === "string" && s.trim())
          .map((s) => s.trim().toUpperCase()),
      )).slice(0, 500)
    : [];
  if (codes.length === 0) return res.status(200).json({});

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Resolve style codes → style_master ids. style_master.style_code
  //    casing is NOT guaranteed uppercase (verified against prod — codes
  //    only line up with ip_item_master after UPPER() on both sides), so a
  //    case-sensitive `.in()` would under-match. Pull the (small, ~2k-row)
  //    id/style_code list and match uppercased in JS. Keep ONE id per
  //    code (first wins) plus a reverse id → code map.
  const wanted = new Set(codes); // already UPPER
  const idToCode = new Map();          // style_master.id → STYLE_CODE_UPPER
  const codeToId = new Map();          // STYLE_CODE_UPPER → style_master.id
  // Paginate — style_master is past PostgREST's 1000-row default cap, so a
  // single select would silently drop styles (and their images).
  const PAGE = 1000;
  for (let from = 0; from < 100000; from += PAGE) {
    const { data: styleRows, error: styleErr } = await admin
      .from("style_master")
      .select("id, style_code")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (styleErr) return res.status(500).json({ error: styleErr.message });
    for (const r of styleRows || []) {
      const codeUp = (r.style_code || "").trim().toUpperCase();
      if (codeUp && r.id && wanted.has(codeUp) && !codeToId.has(codeUp)) {
        codeToId.set(codeUp, r.id); idToCode.set(r.id, codeUp);
      }
    }
    if (!styleRows || styleRows.length < PAGE) break;
  }

  // Always return a slot for every requested code so the client can tell
  // "no image" apart from "still loading".
  const out = {};
  for (const codeUp of codes) out[codeUp] = { style_id: codeToId.get(codeUp) ?? null, default: null, byColor: {} };

  const styleIds = [...idToCode.keys()];
  if (styleIds.length === 0) return res.status(200).json(out);

  // 2. Same image query as style-thumbs.js — primary first, then sort order.
  const { data: rows, error } = await admin
    .from("product_images")
    .select("style_id, color, is_primary, sort_order, storage_path_thumb, storage_path_web")
    .in("style_id", styleIds)
    .order("is_primary", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  // 3. Collect + batch-sign distinct paths.
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

  // 4. Fill the per-code slots.
  for (const r of rows || []) {
    const codeUp = idToCode.get(r.style_id);
    if (!codeUp) continue;
    const p = r.storage_path_thumb || r.storage_path_web;
    const url = p ? signedByPath.get(p) : null;
    if (!url) continue;
    const slot = out[codeUp];
    if (!slot) continue;
    if (!slot.default) slot.default = url;
    const key = (r.color || "").toLowerCase().trim();
    if (key && !slot.byColor[key]) slot.byColor[key] = url;
  }

  return res.status(200).json(out);
}
