// api/internal/parts/:part_id/images/:image_id
//
// PATCH  — update one image's mutable fields: { sort_order?, is_primary?, alt_text? }.
//          Setting is_primary=true clears any existing primary on the same part
//          first (two-step swap; sidesteps the "one primary per part" index).
// DELETE — hard-delete: removes the storage objects (thumb/web/print) AND the
//          part_images row.
//
// Reuses the pim-images UUID guard. Mirrors the PIM style-image [id] handlers.

import { createClient } from "@supabase/supabase-js";
import { isUuid } from "../../../../../_lib/pim-images.js";

export const config = { maxDuration: 15 };
const BUCKET = "pim-images";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function getIds(req) {
  return { id: req.query?.image_id, part_id: req.query?.part_id };
}

/** Every distinct, non-null storage path on a part_images row. */
function collectStoragePaths(row) {
  if (!row) return [];
  const keys = ["storage_path", "storage_path_thumb", "storage_path_web"];
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    const p = row[k];
    if (typeof p === "string" && p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { id, part_id } = getIds(req);
  if (!isUuid(id))      return res.status(400).json({ error: "Invalid image id" });
  if (!isUuid(part_id)) return res.status(400).json({ error: "Invalid part_id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Confirm the image belongs to the part on the URL.
  const { data: existing, error: fetchErr } = await admin
    .from("part_images").select("*").eq("id", id).maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!existing) return res.status(404).json({ error: "Image not found" });
  if (existing.part_id !== part_id) return res.status(404).json({ error: "Image does not belong to this part" });

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    const patch = {};
    if ("sort_order" in body) {
      const n = Number(body.sort_order);
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: "sort_order must be a non-negative integer" });
      patch.sort_order = n;
    }
    if ("is_primary" in body) {
      if (typeof body.is_primary !== "boolean") return res.status(400).json({ error: "is_primary must be boolean" });
      patch.is_primary = body.is_primary;
    }
    if ("alt_text" in body) {
      patch.alt_text = body.alt_text == null ? null : (String(body.alt_text).trim() || null);
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "no patchable fields supplied" });

    // Clear any existing primary on this part before flipping this row to primary.
    if (patch.is_primary === true) {
      const { error: clrErr } = await admin
        .from("part_images").update({ is_primary: false })
        .eq("part_id", part_id).eq("is_primary", true).neq("id", id);
      if (clrErr) return res.status(500).json({ error: "Could not clear existing primary", details: clrErr.message });
    }

    const { data: updated, error: upErr } = await admin
      .from("part_images").update(patch).eq("id", id).select().single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    const paths = collectStoragePaths(existing);
    let storageError = null;
    if (paths.length > 0) {
      const { error: stErr } = await admin.storage.from(BUCKET).remove(paths);
      if (stErr) storageError = stErr.message;
    }
    const { error: delErr } = await admin.from("part_images").delete().eq("id", id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ deleted: true, id, removed_paths: paths, storage_error: storageError });
  }

  res.setHeader("Allow", "PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
