// Image attachment helpers for the Ask AI panel (PR 3/4).
//
// Pure functions: file → validation result and file → base64 payload
// in the shape the server (and downstream the Anthropic SDK) expects.
// Browser-only — no Node fallback, no fetch. Component code imports
// these so the React layer stays presentational.
//
// Caps match the server: stay in sync with MAX_ATTACHMENT_BYTES /
// MAX_ATTACHMENTS_PER_TURN / SUPPORTED_IMAGE_MEDIA_TYPES in
// api/_lib/ai/constants.js.

export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// 5 MB ceiling per image. The Anthropic Vision input limit is higher
// (per the docs ~5MB after base64 expansion), but holding the line at
// 5MB on the raw file keeps the request body manageable + protects
// the operator from accidentally pasting a 50MB PDF screenshot.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// Hard cap on attachments per turn. Mostly for cost — each image costs
// roughly the same as a few hundred tokens of text input.
export const MAX_ATTACHMENTS_PER_TURN = 3;

export interface ImageAttachment {
  /** "image/png" / "image/jpeg" / etc. */
  media_type: string;
  /** Raw base64 (no `data:...;base64,` prefix). */
  data: string;
  /** Object URL for the in-panel thumbnail. Caller is responsible for
   *  revoking when removing the attachment. */
  previewUrl: string;
  /** Friendly filename for the attachment chip. */
  name: string;
  /** Original byte size for the "x MB" hint. */
  size: number;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** Validate an image file's media type + size. Pure, no I/O. */
export function validateAttachment(file: { type: string; size: number; name?: string }): ValidationResult {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    return { ok: false, error: `Unsupported file type ${file.type || "(unknown)"} — only PNG, JPEG, GIF, and WebP are allowed.` };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is ${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)} MB.` };
  }
  if (file.size <= 0) {
    return { ok: false, error: "File is empty." };
  }
  return { ok: true };
}

/**
 * Read a File into an ImageAttachment shape. Throws on validation
 * failure so the caller can surface the error inline.
 */
export async function fileToAttachment(file: File): Promise<ImageAttachment> {
  const v = validateAttachment(file);
  if (!v.ok) throw new Error(v.error || "Invalid attachment");

  // Read as data URL to extract the base64 chunk + retain the preview
  // url for the thumbnail without a second pass through createObjectURL.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
  const commaIdx = dataUrl.indexOf(",");
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : "";
  if (!base64) throw new Error("File read produced empty content");

  // Separate object URL for the thumbnail — data URLs in <img src> are
  // valid but the panel previews several at once; an object URL is more
  // memory-efficient and we control its lifetime explicitly.
  const previewUrl = URL.createObjectURL(file);

  return {
    media_type: file.type,
    data: base64,
    previewUrl,
    name: file.name || "screenshot",
    size: file.size,
  };
}

/**
 * Extract image files from a list of `DataTransferItem`s. Used by
 * both the paste handler (clipboardData.items) and the drop handler
 * (dataTransfer.items).
 */
export function imagesFromDataTransferItems(items: DataTransferItemList | undefined | null): File[] {
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file" && SUPPORTED_IMAGE_TYPES.has(it.type)) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** Revoke the object URLs created by `fileToAttachment` so memory frees. */
export function revokeAttachmentPreviews(attachments: ImageAttachment[]): void {
  for (const a of attachments) {
    try { URL.revokeObjectURL(a.previewUrl); } catch { /* ignore */ }
  }
}
