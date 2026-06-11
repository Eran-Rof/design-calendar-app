// exportImages — fetch remote image URLs into base64 data URLs so they can be
// EMBEDDED (real bytes) in an Excel/PDF export. Browser-only (uses fetch +
// FileReader). We embed bytes rather than =IMAGE()/linked URLs because a
// downloaded report must render offline, in every Excel version, and signed
// URLs expire — so a live link would rot.
//
// Dedupes by URL and fetches in parallel. Any failure (network, CORS, non-
// image) resolves to "skipped" — a missing thumbnail must never break a report.
//
// Optionally trims the near-white studio background off each thumbnail (the
// PIM product shots frame the garment in a tall white canvas, so embedding the
// raw image leaves the product floating in white even when the image fills the
// cell). Trimming crops to the product's bounding box so it actually fills the
// export cell. Always safe: any failure or implausible crop keeps the original.

// ── Pure trim geometry (no DOM — unit-testable) ─────────────────────────────
// Given RGBA pixels + dimensions, find the bounding box of non-near-white
// content and return a crop rect (with a little padding). Returns null when
// there's nothing worth trimming, the result would be implausibly small
// (guards against eating a light-colored product), or inputs are malformed —
// callers treat null as "keep the original image".
export function computeTrimBox(
  rgba: Uint8ClampedArray | Uint8Array | number[],
  w: number,
  h: number,
  opts?: { colorTol?: number; minAreaFrac?: number; padFrac?: number; rowTolFrac?: number; cornerSpread?: number },
): { sx: number; sy: number; sw: number; sh: number } | null {
  const tol = opts?.colorTol ?? 16;           // per-channel distance from the backdrop
  const minAreaFrac = opts?.minAreaFrac ?? 0.12; // don't crop below 12% of area
  const padFrac = opts?.padFrac ?? 0.04;      // breathing room around content
  const tolFrac = opts?.rowTolFrac ?? 0.01;   // a row/col may be ≤1% non-bg
  const maxCornerSpread = opts?.cornerSpread ?? 40; // corners must roughly agree
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (rgba.length < w * h * 4) return null;

  // Detect the backdrop color from the four corners instead of assuming pure
  // white — PIM studio shots sit on off-white / light-grey / faintly-gradient
  // canvases that a hard "≥248" test would miss entirely (so nothing trims).
  const corner = (x: number, y: number): [number, number, number] => {
    const i = (y * w + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]];
  };
  const corners = [corner(0, 0), corner(w - 1, 0), corner(0, h - 1), corner(w - 1, h - 1)];
  const bg = [0, 1, 2].map((c) => Math.round((corners[0][c] + corners[1][c] + corners[2][c] + corners[3][c]) / 4));
  // Only trim when there's a genuine LIGHT, UNIFORM backdrop. Dark or
  // disagreeing corners mean the product likely reaches the edge — bail
  // rather than risk cropping into it.
  if (bg[0] < 150 || bg[1] < 150 || bg[2] < 150) return null;
  const spread = Math.max(...[0, 1, 2].map((c) =>
    Math.max(corners[0][c], corners[1][c], corners[2][c], corners[3][c]) -
    Math.min(corners[0][c], corners[1][c], corners[2][c], corners[3][c])));
  if (spread > maxCornerSpread) return null;

  const isBg = (idx: number) =>
    Math.abs(rgba[idx] - bg[0]) <= tol &&
    Math.abs(rgba[idx + 1] - bg[1]) <= tol &&
    Math.abs(rgba[idx + 2] - bg[2]) <= tol;

  // Tolerate a few stray non-white pixels (JPEG ringing, dust) so a single
  // speck doesn't anchor the bounding box to the image edge.
  const rowLimit = Math.max(1, Math.floor(w * tolFrac));
  const colLimit = Math.max(1, Math.floor(h * tolFrac));
  const rowIsBg = (y: number) => {
    let nonBg = 0;
    const base = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (!isBg(base + x * 4)) { if (++nonBg > rowLimit) return false; }
    }
    return true;
  };
  const colIsBg = (x: number) => {
    let nonBg = 0;
    const xo = x * 4;
    for (let y = 0; y < h; y++) {
      if (!isBg(y * w * 4 + xo)) { if (++nonBg > colLimit) return false; }
    }
    return true;
  };

  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && rowIsBg(top)) top++;
  while (bottom > top && rowIsBg(bottom)) bottom--;
  while (left < right && colIsBg(left)) left++;
  while (right > left && colIsBg(right)) right--;

  const bw = right - left + 1;
  const bh = bottom - top + 1;
  if (bw <= 0 || bh <= 0) return null;
  if (bw * bh < w * h * minAreaFrac) return null; // implausible over-crop → bail
  if (left === 0 && top === 0 && right === w - 1 && bottom === h - 1) return null; // nothing trimmed

  const pad = Math.round(Math.min(bw, bh) * padFrac);
  const sx = Math.max(0, left - pad);
  const sy = Math.max(0, top - pad);
  const sw = Math.min(w - sx, bw + 2 * pad);
  const sh = Math.min(h - sy, bh + 2 * pad);
  return { sx, sy, sw, sh };
}

// A processed thumbnail: the bytes to embed plus its EXACT pixel dimensions.
// Carrying the real w/h lets the Excel layer size the cell to the image (so the
// box always fits the picture — no empty space) without re-parsing the bytes
// with a fragile in-house decoder.
export interface ExportImage {
  dataUrl: string;
  w: number;
  h: number;
}

// ── Browser image processing (canvas) ───────────────────────────────────────
function loadImage(src: string, timeoutMs = 15000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return; done = true; clearTimeout(timer);
      ok ? resolve(img) : reject(new Error("image load failed"));
    };
    const timer = setTimeout(() => finish(false), timeoutMs); // never hang the batch
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = src;
  });
}

// Compute box on a small downscaled copy (cheap, OOM-safe across ~100 images),
// then crop the full-res image — but cap the OUTPUT canvas so a huge web image
// can't blow canvas/area limits (which makes toDataURL return an empty string,
// the likely cause of "only some images came through"). Returns the cropped
// ExportImage, or null to signal "keep the original".
const SAMPLE = 260;     // long-edge px for the box-detection pass
const MAX_OUT = 700;    // long-edge px cap for the embedded crop (display is ~225px)
function trimLoadedImage(img: HTMLImageElement, W: number, H: number): ExportImage | null {
  try {
    if (typeof document === "undefined") return null;
    const scale = Math.min(1, SAMPLE / Math.max(W, H));
    const sw = Math.max(1, Math.round(W * scale));
    const sh = Math.max(1, Math.round(H * scale));
    const sc = document.createElement("canvas");
    sc.width = sw; sc.height = sh;
    const sctx = sc.getContext("2d");
    if (!sctx) return null;
    sctx.drawImage(img, 0, 0, sw, sh);
    let rgba: Uint8ClampedArray;
    try { rgba = sctx.getImageData(0, 0, sw, sh).data; } catch { return null; } // tainted → bail
    const box = computeTrimBox(rgba, sw, sh);
    if (!box) return null;

    // Scale the small-image box back to full-res coordinates.
    const fx = W / sw, fy = H / sh;
    const cx = Math.max(0, Math.floor(box.sx * fx));
    const cy = Math.max(0, Math.floor(box.sy * fy));
    const cw = Math.min(W - cx, Math.ceil(box.sw * fx));
    const ch = Math.min(H - cy, Math.ceil(box.sh * fy));
    if (cw <= 0 || ch <= 0) return null;

    // Cap the output so toDataURL can't fail on an oversized canvas.
    const outScale = Math.min(1, MAX_OUT / Math.max(cw, ch));
    const ow = Math.max(1, Math.round(cw * outScale));
    const oh = Math.max(1, Math.round(ch * outScale));
    const o = document.createElement("canvas");
    o.width = ow; o.height = oh;
    const octx = o.getContext("2d");
    if (!octx) return null;
    octx.fillStyle = "#ffffff"; // matte, in case the source had transparency
    octx.fillRect(0, 0, ow, oh);
    octx.drawImage(img, cx, cy, cw, ch, 0, 0, ow, oh);
    const dataUrl = o.toDataURL("image/jpeg", 0.9);
    if (!dataUrl || dataUrl.length < 32) return null; // encode failed → keep original
    return { dataUrl, w: ow, h: oh };
  } catch {
    return null;
  }
}

// Load a data-URL image, measure its true size, and (optionally) trim the light
// studio backdrop. Always resolves to an ExportImage — trim failures fall back
// to the original bytes + measured size, so we never drop a thumbnail.
async function processImage(dataUrl: string, trim: boolean): Promise<ExportImage> {
  if (typeof document === "undefined") return { dataUrl, w: 0, h: 0 };
  try {
    const img = await loadImage(dataUrl);
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) return { dataUrl, w: 0, h: 0 };
    if (trim) {
      const trimmed = trimLoadedImage(img, W, H);
      if (trimmed) return trimmed;
    }
    return { dataUrl, w: W, h: H };
  } catch {
    return { dataUrl, w: 0, h: 0 };
  }
}

export async function fetchDataUrls(
  urls: Array<string | null | undefined>,
  opts?: { trimWhitespace?: boolean },
): Promise<Map<string, ExportImage>> {
  const unique = Array.from(new Set(urls.filter((u): u is string => !!u)));
  const out = new Map<string, ExportImage>();
  await Promise.all(
    unique.map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) return;
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error("read failed"));
          fr.readAsDataURL(blob);
        });
        out.set(url, await processImage(dataUrl, !!opts?.trimWhitespace));
      } catch {
        /* skip — thumbnail just stays blank */
      }
    }),
  );
  return out;
}
