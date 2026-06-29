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

// Core (base) style code for the image fallback: a trailing VARIANT suffix that
// follows the numeric style code is the same garment, so it shares the core
// style's images. Strips a trailing alpha(+digits) suffix sitting right after a
// digit — covers B, PPK, PPK24, PL, KO, etc.:
//   RYB0412B → RYB0412   RYB0412PPK → RYB0412   RYB0981PL → RYB0981
// Returns the core (UPPER) or null when there's no suffix to strip.
function coreStyleCode(codeUp) {
  const m = codeUp.replace(/(\d)[-_]?[A-Z]+\d*$/, "$1");
  return m !== codeUp ? m : null;
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

  // Opt-in higher-res source. Default = thumb (grid thumbnails); the Excel
  // export passes variant:"web" so its larger embedded images stay crisp.
  const preferWeb = body?.variant === "web";

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Resolve style codes → style_master ids. style_master.style_code
  //    casing is NOT guaranteed uppercase (verified against prod — codes
  //    only line up with ip_item_master after UPPER() on both sides), so a
  //    case-sensitive `.in()` would under-match. Pull the (small, ~2k-row)
  //    id/style_code list and match uppercased in JS. Keep ONE id per
  //    code (first wins) plus a reverse id → code map.
  // Core-style image fallback: a code with no images of its own inherits its
  // core style's images. Resolve the cores too (add them to the wanted set).
  const coreByCode = new Map(); // requested CODE_UPPER → core CODE_UPPER
  for (const c of codes) { const core = coreStyleCode(c); if (core && core !== c) coreByCode.set(c, core); }
  const wanted = new Set(codes); // already UPPER
  for (const core of coreByCode.values()) wanted.add(core);
  const idToCode = new Map();          // style_master.id → STYLE_CODE_UPPER (requested codes only)
  const codeToId = new Map();          // STYLE_CODE_UPPER → style_master.id (requested + cores)
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
    const p = preferWeb ? (r.storage_path_web || r.storage_path_thumb) : (r.storage_path_thumb || r.storage_path_web);
    if (p && !seenPath.has(p)) { seenPath.add(p); paths.push(p); }
  }
  const signedByPath = new Map();
  if (paths.length > 0) {
    const { data: signed } = await admin.storage.from(BUCKET).createSignedUrls(paths, TTL);
    for (const s of signed || []) if (s && !s.error && s.signedUrl) signedByPath.set(s.path, s.signedUrl);
  }

  // 4. Group images by style_id (covers requested codes AND their cores).
  const imgByStyle = new Map(); // style_id → { default, byColor }
  for (const r of rows || []) {
    const p = preferWeb ? (r.storage_path_web || r.storage_path_thumb) : (r.storage_path_thumb || r.storage_path_web);
    const url = p ? signedByPath.get(p) : null;
    if (!url) continue;
    let g = imgByStyle.get(r.style_id);
    if (!g) { g = { default: null, byColor: {} }; imgByStyle.set(r.style_id, g); }
    if (!g.default) g.default = url;
    const key = (r.color || "").toLowerCase().trim();
    if (key && !g.byColor[key]) g.byColor[key] = url;
  }

  // 5. Assemble each requested code: its OWN images, else its CORE style's
  //    images (e.g. RYB0412B → RYB0412). style_id points at whichever style the
  //    shown images belong to, so the gallery opens the right one.
  for (const codeUp of codes) {
    const ownId = codeToId.get(codeUp) ?? null;
    const own = ownId ? imgByStyle.get(ownId) : null;
    if (own && own.default) {
      out[codeUp] = { style_id: ownId, default: own.default, byColor: { ...own.byColor } };
      continue;
    }
    const coreCode = coreByCode.get(codeUp);
    const coreId = coreCode ? (codeToId.get(coreCode) ?? null) : null;
    const core = coreId ? imgByStyle.get(coreId) : null;
    if (core && core.default) {
      out[codeUp] = { style_id: coreId, default: core.default, byColor: { ...core.byColor } };
    } else {
      out[codeUp] = { style_id: ownId, default: null, byColor: {} };
    }
  }

  return res.status(200).json(out);
}
