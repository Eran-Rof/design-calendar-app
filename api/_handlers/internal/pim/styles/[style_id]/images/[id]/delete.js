// api/internal/pim/styles/:style_id/images/:id/delete
//
// POST — hard-delete one image: removes the storage objects (all 3
//        derivatives) AND the product_images row. v1 uses hard-DELETE per
//        spec; a future cleanup cron + soft-delete column can land later
//        without changing this endpoint's contract.
//
// Tangerine P8-7 (arch §6).

import { createClient } from "@supabase/supabase-js";
import { isUuid } from "../../../../../../../_lib/pim-images.js";

export const config = { maxDuration: 15 };
const BUCKET = "pim-images";

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

function getIds(req) {
  return { id: req.query?.id, style_id: req.query?.style_id };
}

/**
 * Collect every distinct, non-null storage path on a product_images row.
 * Some rows pre-derivative-pipeline may only have storage_path set; this
 * picks up all that exist so removal doesn't silently leak.
 */
export function collectStoragePaths(row) {
  if (!row) return [];
  const keys = ["storage_path", "storage_path_thumb", "storage_path_web", "storage_path_print"];
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    const p = row[k];
    if (typeof p === "string" && p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id, style_id } = getIds(req);
  if (!isUuid(id))       return res.status(400).json({ error: "Invalid image id" });
  if (!isUuid(style_id)) return res.status(400).json({ error: "Invalid style_id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: row, error: fetchErr } = await admin
    .from("product_images")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "Image not found" });
  if (row.style_id !== style_id) {
    return res.status(404).json({ error: "Image does not belong to this style" });
  }

  // 1. Remove the storage objects first. If a derivative is missing
  //    (e.g. legacy row), Supabase returns success-with-empty rather than
  //    a fatal error — we ignore individual misses.
  const paths = collectStoragePaths(row);
  let storageError = null;
  if (paths.length > 0) {
    const { error: stErr } = await admin.storage.from(BUCKET).remove(paths);
    if (stErr) storageError = stErr.message;
  }

  // 2. Delete the row. Done even if storage cleanup failed so a stuck
  //    row never wedges the UI; the orphan files are surfaced in the
  //    response body for the operator to clean up.
  const { error: delErr } = await admin
    .from("product_images")
    .delete()
    .eq("id", id);
  if (delErr) return res.status(500).json({ error: delErr.message });

  return res.status(200).json({
    deleted: true,
    id,
    removed_paths: paths,
    storage_error: storageError,
  });
}
