// api/internal/pim/styles/:style_id/images
//
// GET  — list images for a style, ordered (is_primary DESC, sort_order ASC,
//        created_at ASC). Returns signed URLs for each derivative (1h TTL).
// POST — multipart upload of a new image.
//        Field name: `file` (required). Optional fields (form fields):
//          alt_text, image_kind (flat|lifestyle|spec|swatch|other),
//          sort_order (int), is_primary (true|false),
//          uploaded_by_user_id (uuid).
//        Pipeline:
//          1. validateUploadFile  (pre-flight: ≤10MB, jpeg/png/webp mime)
//          2. processImage        (Sharp: thumb/web/print derivatives,
//                                  rejects >4096px)
//          3. upload each derivative to the pim-images bucket
//          4. INSERT product_images row (storage_path = print path,
//             storage_path_thumb/_web/_print set, mime_type='image/jpeg')
//          5. return { row, signedUrls: { thumb, web, print } }
//
// Tangerine P8-7 (arch §6 + P8-data-crm-architecture.md §5.5).

import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import { readFileSync } from "node:fs";
import {
  validateUploadFile,
  processImage,
  storagePathFor,
  newImageId,
  isUuid,
  loadSharp,
  IMAGE_KIND_VALUES,
} from "../../../../../../_lib/pim-images.js";

// Image processing on 4K inputs can run 5-10s for the largest sources.
// Bumped from the default 15s ceiling so a slow Sharp encode doesn't 504.
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

/** Read style_id from the dispatcher's req.query merged path params. */
function getStyleId(req) {
  if (req.query?.style_id) return req.query.style_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const tail = parts.lastIndexOf("images");
  return tail > 0 ? parts[tail - 1] : null;
}

/** Pick the single file value out of formidable's `files` shape. */
function pickFile(files, ...keys) {
  for (const k of keys) {
    const v = files[k];
    if (v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

/** Pull a scalar form field — formidable v3 yields each as an array. */
function pickField(fields, key) {
  const v = fields[key];
  if (v == null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s : (s == null ? null : String(s));
}

/**
 * Issue signed URLs for the 3 derivative paths in parallel.
 * Returns { thumb, web, print } — each value is the signed URL string or
 * null if Supabase reported an error (e.g. the path is missing because the
 * row was inserted before the upload completed, in a degraded scenario).
 */
export async function signDerivativeUrls(admin, paths, ttl = SIGNED_URL_TTL_S) {
  const out = { thumb: null, web: null, print: null };
  const kinds = ["thumb", "web", "print"];
  await Promise.all(kinds.map(async (k) => {
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

  const styleId = getStyleId(req);
  if (!isUuid(styleId)) return res.status(400).json({ error: "Invalid style_id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Style must exist (and belong to the default entity).
  const { data: style, error: styleErr } = await admin
    .from("style_master")
    .select("id, entity_id")
    .eq("id", styleId)
    .maybeSingle();
  if (styleErr) return res.status(500).json({ error: styleErr.message });
  if (!style) return res.status(404).json({ error: "Style not found" });

  const entityId = style.entity_id || (await resolveDefaultEntityId(admin));
  if (!entityId) return res.status(500).json({ error: "Could not resolve entity_id" });

  if (req.method === "GET") {
    const { data: rows, error } = await admin
      .from("product_images")
      .select("*")
      .eq("style_id", styleId)
      .order("is_primary", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const enriched = await Promise.all((rows || []).map(async (row) => {
      const signed = await signDerivativeUrls(admin, {
        thumb: row.storage_path_thumb,
        web:   row.storage_path_web,
        print: row.storage_path_print,
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
    if (!sharpLib) {
      return res.status(500).json({ error: "Sharp not available on this deployment" });
    }
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
      thumb: storagePathFor(entityId, styleId, imageId, "thumb"),
      web:   storagePathFor(entityId, styleId, imageId, "web"),
      print: storagePathFor(entityId, styleId, imageId, "print"),
    };
    const uploadKinds = ["thumb", "web", "print"];
    try {
      for (const k of uploadKinds) {
        const { error: upErr } = await admin.storage
          .from(BUCKET)
          .upload(paths[k], derivs[k].buffer, {
            contentType: "image/jpeg",
            upsert: false,
          });
        if (upErr) throw new Error(`upload ${k}: ${upErr.message}`);
      }
    } catch (e) {
      // Best-effort cleanup: any derivative that got through is removed
      // so we don't leak orphaned objects.
      await admin.storage.from(BUCKET)
        .remove(uploadKinds.map((k) => paths[k]))
        .catch(() => {});
      return res.status(500).json({ error: "Storage upload failed", details: e.message });
    }

    // 4. Parse optional metadata fields.
    const altText = pickField(fields, "alt_text");
    const imageKindRaw = pickField(fields, "image_kind");
    const imageKind = imageKindRaw && IMAGE_KIND_VALUES.includes(imageKindRaw) ? imageKindRaw : "flat";
    const sortOrderRaw = pickField(fields, "sort_order");
    const sortOrder = sortOrderRaw != null && /^\d+$/.test(sortOrderRaw) ? parseInt(sortOrderRaw, 10) : 0;
    const isPrimaryRaw = pickField(fields, "is_primary");
    const isPrimary = isPrimaryRaw === "true" || isPrimaryRaw === "1";
    const uploadedByRaw = pickField(fields, "uploaded_by_user_id");
    const uploadedBy = isUuid(uploadedByRaw) ? uploadedByRaw : null;

    // If the upload claims is_primary, clear any existing primary first to
    // sidestep the EXCLUDE constraint. Two-step swap; cheap for low N/style.
    if (isPrimary) {
      const { error: clrErr } = await admin
        .from("product_images")
        .update({ is_primary: false })
        .eq("style_id", styleId)
        .eq("is_primary", true);
      if (clrErr) {
        await admin.storage.from(BUCKET)
          .remove(uploadKinds.map((k) => paths[k])).catch(() => {});
        return res.status(500).json({ error: "Could not clear existing primary", details: clrErr.message });
      }
    }

    // 5. INSERT product_images row. storage_path stores the print path —
    // we skip storing the original buffer (decision noted in the PR body).
    const row = {
      id: imageId,
      entity_id: entityId,
      style_id: styleId,
      image_kind: imageKind,
      storage_path: paths.print,
      storage_path_thumb: paths.thumb,
      storage_path_web:   paths.web,
      storage_path_print: paths.print,
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
      .from("product_images")
      .insert(row)
      .select()
      .single();
    if (insErr) {
      // DB-side failure: drop the storage objects so we don't leak.
      await admin.storage.from(BUCKET)
        .remove(uploadKinds.map((k) => paths[k])).catch(() => {});
      return res.status(500).json({ error: insErr.message });
    }

    // 6. Signed URLs for client convenience.
    const signed = await signDerivativeUrls(admin, paths);
    return res.status(201).json({ ...inserted, signed_urls: signed });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
