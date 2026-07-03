// api/internal/parts/:part_id/images
//
// GET  — list images for a part, ordered (is_primary DESC, sort_order ASC,
//        created_at ASC). Returns 1h signed URLs for each derivative.
// POST — multipart upload of a new image.
//        Field name: `file` (required). Optional form fields:
//          alt_text, sort_order (int), is_primary (true|false),
//          uploaded_by_user_id (uuid).
//        Pipeline mirrors the PIM style-images handler:
//          1. validateUploadFile  (≤10MB, jpeg/png/webp)
//          2. processImage        (Sharp: thumb/web/print derivatives)
//          3. upload each derivative to the pim-images bucket under
//             <entity>/parts/<part_id>/<image_id>-<kind>.jpg
//          4. INSERT part_images row (storage_path = print/largest path,
//             storage_path_thumb/_web set)
//          5. return { row, signed_urls: { thumb, web, print } }
//
// Reuses api/_lib/pim-images.js for all image processing.

import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import { readFileSync } from "node:fs";
import {
  validateUploadFile,
  processImage,
  newImageId,
  isUuid,
  loadSharp,
  UUID_RE,
} from "../../../../../_lib/pim-images.js";

// Sharp on 4K inputs can run 5-10s; bump the ceiling so a slow encode doesn't 504.
export const config = { api: { bodyParser: false }, maxDuration: 60 };

const BUCKET = "pim-images";
const SIGNED_URL_TTL_S = 3600;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

/** Storage path convention for part images (parallels storagePathFor). */
export function partStoragePathFor(entityId, partId, imageId, kind) {
  if (!UUID_RE.test(String(entityId || ""))) throw new Error("entityId must be uuid");
  if (!UUID_RE.test(String(partId  || ""))) throw new Error("partId must be uuid");
  if (!UUID_RE.test(String(imageId || ""))) throw new Error("imageId must be uuid");
  if (!["thumb", "web", "print"].includes(kind)) throw new Error(`unknown derivative kind: ${kind}`);
  return `${entityId}/parts/${partId}/${imageId}-${kind}.jpg`;
}

/** Read part_id from the dispatcher's req.query merged path params. */
function getPartId(req) {
  if (req.query?.part_id) return req.query.part_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const tail = parts.lastIndexOf("images");
  return tail > 0 ? parts[tail - 1] : null;
}

function pickFile(files, ...keys) {
  for (const k of keys) {
    const v = files[k];
    if (v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}
function pickField(fields, key) {
  const v = fields[key];
  if (v == null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s : (s == null ? null : String(s));
}

/** Issue signed URLs for the thumb/web/print paths in parallel. */
export async function signDerivativeUrls(admin, paths, ttl = SIGNED_URL_TTL_S) {
  const out = { thumb: null, web: null, print: null };
  await Promise.all(["thumb", "web", "print"].map(async (k) => {
    const p = paths[k];
    if (!p) return;
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(p, ttl);
    if (!error && data?.signedUrl) out[k] = data.signedUrl;
  }));
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const partId = getPartId(req);
  if (!isUuid(partId)) return res.status(400).json({ error: "Invalid part_id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Part must exist (and gives us its entity_id).
  const { data: part, error: partErr } = await admin
    .from("part_master")
    .select("id, entity_id")
    .eq("id", partId)
    .maybeSingle();
  if (partErr) return res.status(500).json({ error: partErr.message });
  if (!part) return res.status(404).json({ error: "Part not found" });

  const entityId = part.entity_id || (await resolveDefaultEntityId(admin));
  if (!entityId) return res.status(500).json({ error: "Could not resolve entity_id" });

  if (req.method === "GET") {
    const { data: rows, error } = await admin
      .from("part_images")
      .select("*")
      .eq("part_id", partId)
      .order("is_primary", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const enriched = await Promise.all((rows || []).map(async (row) => {
      const signed = await signDerivativeUrls(admin, {
        thumb: row.storage_path_thumb,
        web:   row.storage_path_web,
        print: row.storage_path,
      });
      return { ...row, signed_urls: signed };
    }));
    return res.status(200).json(enriched);
  }

  if (req.method === "POST") {
    // 1. Multipart parse.
    const form = formidable({ maxFileSize: 10 * 1024 * 1024, multiples: false });
    let fields, files;
    try {
      [fields, files] = await form.parse(req);
    } catch (e) {
      return res.status(400).json({ error: "Multipart parse error", details: e.message });
    }

    const file = pickFile(files, "file", "image", "upload");
    const v = validateUploadFile(file);
    if (v.error) return res.status(400).json({ error: v.error });

    // 2. Sharp pipeline.
    const sharpLib = await loadSharp();
    if (!sharpLib) return res.status(500).json({ error: "Sharp not available on this deployment" });
    let buf;
    try {
      buf = readFileSync(file.filepath);
    } catch (e) {
      return res.status(500).json({ error: "could not read uploaded file", details: e.message });
    }
    let derivs;
    try {
      derivs = await processImage(buf, { sharp: sharpLib });
    } catch (e) {
      return res.status(400).json({ error: "Image processing failed", details: e.message });
    }

    // 3. Upload all derivatives.
    const imageId = newImageId();
    const paths = {
      thumb: partStoragePathFor(entityId, partId, imageId, "thumb"),
      web:   partStoragePathFor(entityId, partId, imageId, "web"),
      print: partStoragePathFor(entityId, partId, imageId, "print"),
    };
    const uploadKinds = ["thumb", "web", "print"];
    try {
      for (const k of uploadKinds) {
        const { error: upErr } = await admin.storage
          .from(BUCKET)
          .upload(paths[k], derivs[k].buffer, { contentType: "image/jpeg", upsert: false });
        if (upErr) throw new Error(`upload ${k}: ${upErr.message}`);
      }
    } catch (e) {
      await admin.storage.from(BUCKET).remove(uploadKinds.map((k) => paths[k])).catch(() => {});
      return res.status(500).json({ error: "Storage upload failed", details: e.message });
    }

    // 4. Optional metadata fields.
    const altText = pickField(fields, "alt_text");
    const sortOrderRaw = pickField(fields, "sort_order");
    const sortOrder = sortOrderRaw != null && /^\d+$/.test(sortOrderRaw) ? parseInt(sortOrderRaw, 10) : 0;
    const isPrimaryRaw = pickField(fields, "is_primary");
    // First image for a part is primary by default; explicit true always wins.
    const { count: existingCount } = await admin
      .from("part_images").select("id", { count: "exact", head: true }).eq("part_id", partId);
    const isPrimary = isPrimaryRaw === "true" || isPrimaryRaw === "1" || (existingCount ?? 0) === 0;
    const uploadedByRaw = pickField(fields, "uploaded_by_user_id");
    const uploadedBy = isUuid(uploadedByRaw) ? uploadedByRaw : null;

    // Clear any existing primary first to sidestep the unique index.
    if (isPrimary) {
      const { error: clrErr } = await admin
        .from("part_images").update({ is_primary: false })
        .eq("part_id", partId).eq("is_primary", true);
      if (clrErr) {
        await admin.storage.from(BUCKET).remove(uploadKinds.map((k) => paths[k])).catch(() => {});
        return res.status(500).json({ error: "Could not clear existing primary", details: clrErr.message });
      }
    }

    // 5. INSERT part_images row. storage_path = print (largest) derivative.
    const row = {
      id: imageId,
      entity_id: entityId,
      part_id: partId,
      image_kind: "photo",
      storage_path: paths.print,
      storage_path_thumb: paths.thumb,
      storage_path_web:   paths.web,
      alt_text: altText,
      sort_order: sortOrder,
      is_primary: isPrimary,
      mime_type: "image/jpeg",
      bytes: derivs.print.bytes,
      width: derivs.print.width,
      height: derivs.print.height,
      uploaded_by_user_id: uploadedBy,
    };
    const { data: inserted, error: insErr } = await admin
      .from("part_images").insert(row).select().single();
    if (insErr) {
      await admin.storage.from(BUCKET).remove(uploadKinds.map((k) => paths[k])).catch(() => {});
      return res.status(500).json({ error: insErr.message });
    }

    const signed = await signDerivativeUrls(admin, paths);
    return res.status(201).json({ ...inserted, signed_urls: signed });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
