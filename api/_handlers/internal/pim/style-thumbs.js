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

// Core (base) style code: a trailing variant suffix after the numeric code is
// the same garment, so it shares the core style's images (RYB0412B → RYB0412,
// RYB0412PPK → RYB0412, RYB0981PL → RYB0981). Null when nothing to strip.
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

  // Core-style fallback: any requested style with NO image of its own inherits
  // its core style's images (RYB0412B → RYB0412). Only runs when something is
  // missing, so styles that have their own images cost nothing extra.
  try {
    const missing = ids.filter((id) => !out[id].default);
    if (missing.length > 0) {
      // requested id → its style_code
      const { data: mRows } = await admin.from("style_master").select("id, style_code").in("id", missing);
      const idToCore = new Map();   // missing id → core CODE_UPPER
      const coreCodes = new Set();  // distinct core CODE_UPPER to resolve
      for (const r of mRows || []) {
        const core = coreStyleCode((r.style_code || "").trim().toUpperCase());
        if (core) { idToCore.set(r.id, core); coreCodes.add(core); }
      }
      if (coreCodes.size > 0) {
        // Resolve core codes → ids (style_code casing isn't guaranteed; match UPPER).
        const coreCodeToId = new Map();
        const PAGE = 1000;
        for (let from = 0; from < 100000; from += PAGE) {
          const { data: sRows } = await admin.from("style_master").select("id, style_code")
            .order("id", { ascending: true }).range(from, from + PAGE - 1);
          for (const r of sRows || []) {
            const cu = (r.style_code || "").trim().toUpperCase();
            if (coreCodes.has(cu) && !coreCodeToId.has(cu)) coreCodeToId.set(cu, r.id);
          }
          if (!sRows || sRows.length < PAGE) break;
        }
        const coreIds = [...new Set([...coreCodeToId.values()])];
        if (coreIds.length > 0) {
          const { data: cRows } = await admin.from("product_images")
            .select("style_id, color, is_primary, sort_order, storage_path_thumb, storage_path_web")
            .in("style_id", coreIds)
            .order("is_primary", { ascending: false }).order("sort_order", { ascending: true }).order("created_at", { ascending: true });
          const cPaths = []; const cSeen = new Set();
          for (const r of cRows || []) { const p = r.storage_path_thumb || r.storage_path_web; if (p && !cSeen.has(p)) { cSeen.add(p); cPaths.push(p); } }
          if (cPaths.length > 0) {
            const { data: cSigned } = await admin.storage.from(BUCKET).createSignedUrls(cPaths, TTL);
            for (const s of cSigned || []) if (s && !s.error && s.signedUrl) signedByPath.set(s.path, s.signedUrl);
          }
          const coreImg = new Map(); // core style_id → { default, byColor }
          for (const r of cRows || []) {
            const p = r.storage_path_thumb || r.storage_path_web;
            const url = p ? signedByPath.get(p) : null;
            if (!url) continue;
            let g = coreImg.get(r.style_id);
            if (!g) { g = { default: null, byColor: {} }; coreImg.set(r.style_id, g); }
            if (!g.default) g.default = url;
            const key = (r.color || "").toLowerCase().trim();
            if (key && !g.byColor[key]) g.byColor[key] = url;
          }
          for (const id of missing) {
            const core = idToCore.get(id);
            const coreId = core ? coreCodeToId.get(core) : null;
            const g = coreId ? coreImg.get(coreId) : null;
            if (g && g.default) out[id] = { default: g.default, byColor: { ...g.byColor } };
          }
        }
      }
    }
  } catch { /* fallback is best-effort; never fail the base lookup */ }

  return res.status(200).json(out);
}
