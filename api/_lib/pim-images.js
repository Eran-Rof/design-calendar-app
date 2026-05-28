// api/_lib/pim-images.js — PIM image processing helpers (Tangerine P8-7).
//
// Pure-ish helpers split out so the validators + Sharp pipeline can be
// unit-tested without spinning up a multipart parser or Supabase client.
//
//   - ALLOWED_MIME, MAX_BYTES, MAX_DIM, DERIVATIVE_SIZES — module-level constants
//   - validateUploadFile(file)          → { error } | { ok: true }
//   - validatePatch(body)               → { error } | { data }
//   - storagePathFor(entityId, styleId, imageId, kind) → "<entity>/<style>/<image>-<kind>.jpg"
//   - processImage(buffer, { sharp? })  → { thumb, web, print, meta }
//
// The handlers under api/_handlers/internal/pim/styles/[style_id]/images/*
// import these and add the Supabase storage + DB plumbing.
//
// Sharp is a heavy native dep. We resolve it lazily so the validator-only
// tests don't need it installed in CI's lightweight node_modules tree.

import { randomUUID } from "node:crypto";

export const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_BYTES = 10 * 1024 * 1024;          // 10 MB pre-Sharp
export const MAX_DIM = 4096;                         // 4096 px on either axis
export const DERIVATIVE_SIZES = Object.freeze({
  thumb: 200,
  web:   800,
  print: 2400,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_KIND_VALUES = ["flat", "lifestyle", "spec", "swatch", "other"];

/**
 * Validate an inbound formidable File before Sharp touches it.
 *
 *   file.size           — formidable byte count
 *   file.mimetype       — content-type guessed from the multipart part
 *
 * Sharp-level dimension validation happens after decode (Sharp can read
 * width/height in microseconds; the pre-flight here just keeps us from
 * paying Sharp's decode cost on obviously-bad inputs).
 */
export function validateUploadFile(file) {
  if (!file) return { error: "file is required" };
  if (typeof file.size !== "number" || file.size <= 0) {
    return { error: "file is empty" };
  }
  if (file.size > MAX_BYTES) {
    return { error: `file too large (max ${MAX_BYTES} bytes)` };
  }
  const mime = String(file.mimetype || file.mime || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return { error: `mime ${mime || "(unknown)"} not allowed; must be one of ${[...ALLOWED_MIME].join(", ")}` };
  }
  return { ok: true, mime };
}

/**
 * Validate a PATCH body against the mutable subset the spec allows.
 * Locked: id, entity_id, style_id, storage_path*, width, height, bytes,
 *         mime_type, uploaded_by_user_id, created_at.
 */
export function validatePatch(body) {
  if (!body || typeof body !== "object") return { error: "body required" };
  const LOCKED = [
    "id", "entity_id", "style_id",
    "storage_path", "storage_path_thumb", "storage_path_web", "storage_path_print",
    "width", "height", "bytes", "mime_type",
    "uploaded_by_user_id", "created_at",
  ];
  for (const k of LOCKED) {
    if (k in body) return { error: `${k} is not patchable` };
  }
  const out = {};
  if ("sort_order" in body) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n) || n < 0) return { error: "sort_order must be a non-negative integer" };
    out.sort_order = n;
  }
  if ("is_primary" in body) {
    if (typeof body.is_primary !== "boolean") return { error: "is_primary must be boolean" };
    out.is_primary = body.is_primary;
  }
  if ("alt_text" in body) {
    if (body.alt_text == null) {
      out.alt_text = null;
    } else {
      const s = String(body.alt_text).trim();
      if (s.length > 500) return { error: "alt_text must be ≤ 500 chars" };
      out.alt_text = s || null;
    }
  }
  if ("image_kind" in body) {
    if (!IMAGE_KIND_VALUES.includes(body.image_kind)) {
      return { error: `image_kind must be one of ${IMAGE_KIND_VALUES.join(", ")}` };
    }
    out.image_kind = body.image_kind;
  }
  if (Object.keys(out).length === 0) {
    return { error: "no patchable fields supplied" };
  }
  return { data: out };
}

/**
 * Storage path convention.
 *   pim-images/<entity_id>/<style_id>/<image_id>-thumb.jpg
 *   pim-images/<entity_id>/<style_id>/<image_id>-web.jpg
 *   pim-images/<entity_id>/<style_id>/<image_id>-print.jpg
 *
 * The bucket name is supplied by the caller (default `pim-images`); we
 * return the bucket-relative path because the Supabase storage client
 * already takes bucket separately.
 */
export function storagePathFor(entityId, styleId, imageId, kind) {
  if (!UUID_RE.test(String(entityId || ""))) throw new Error("entityId must be uuid");
  if (!UUID_RE.test(String(styleId  || ""))) throw new Error("styleId must be uuid");
  if (!UUID_RE.test(String(imageId  || ""))) throw new Error("imageId must be uuid");
  if (!["thumb", "web", "print"].includes(kind)) throw new Error(`unknown derivative kind: ${kind}`);
  return `${entityId}/${styleId}/${imageId}-${kind}.jpg`;
}

/**
 * Run a buffer through Sharp and produce 3 JPEG derivatives.
 *
 * Returns { thumb, web, print, meta } where each entry is
 *   { buffer: Buffer, width: int, height: int, bytes: int }
 * and `meta` is the original-image metadata { width, height, format }.
 *
 * Aspect ratio is preserved; resize uses "inside" fit so the longer side
 * matches DERIVATIVE_SIZES[kind] and the shorter side scales down. Inputs
 * already smaller than a derivative size are NOT upscaled — Sharp's
 * `withoutEnlargement: true` honours that.
 *
 * The `sharp` arg is injectable so tests can pass a mock — runtime callers
 * resolve it via `await loadSharp()`.
 */
export async function processImage(input, opts = {}) {
  const sharpLib = opts.sharp || (await loadSharp());
  if (!sharpLib) throw new Error("sharp module not available");

  const probe = sharpLib(input);
  const meta = await probe.metadata();
  if (!meta || !meta.width || !meta.height) {
    throw new Error("could not read image metadata");
  }
  if (meta.width > MAX_DIM || meta.height > MAX_DIM) {
    throw new Error(`image dimensions ${meta.width}x${meta.height} exceed ${MAX_DIM}px max`);
  }

  const out = {};
  for (const kind of ["thumb", "web", "print"]) {
    const px = DERIVATIVE_SIZES[kind];
    const buf = await sharpLib(input)
      .rotate() // honour EXIF orientation before resize
      .resize({ width: px, height: px, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: kind === "thumb" ? 80 : 88, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });
    out[kind] = {
      buffer: buf.data,
      width:  buf.info.width,
      height: buf.info.height,
      bytes:  buf.info.size,
    };
  }
  out.meta = {
    width:  meta.width,
    height: meta.height,
    format: meta.format,
  };
  return out;
}

/**
 * Lazy Sharp loader. Sharp is a heavy native dep — we only need it on the
 * upload path. Returns null if the module isn't installed (used by tests).
 */
export async function loadSharp() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch {
    return null;
  }
}

/** Generate a uuid for use as the product_images.id (and storage filename). */
export function newImageId() {
  return randomUUID();
}

/** Type guard reused across handlers. */
export function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export { UUID_RE, IMAGE_KIND_VALUES };
