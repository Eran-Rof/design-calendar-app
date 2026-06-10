// exportImages — fetch remote image URLs into base64 data URLs so they can be
// EMBEDDED (real bytes) in an Excel/PDF export. Browser-only (uses fetch +
// FileReader). We embed bytes rather than =IMAGE()/linked URLs because a
// downloaded report must render offline, in every Excel version, and signed
// URLs expire — so a live link would rot.
//
// Dedupes by URL and fetches in parallel. Any failure (network, CORS, non-
// image) resolves to "skipped" — a missing thumbnail must never break a report.

export async function fetchDataUrls(
  urls: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(urls.filter((u): u is string => !!u)));
  const out = new Map<string, string>();
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
        out.set(url, dataUrl);
      } catch {
        /* skip — thumbnail just stays blank */
      }
    }),
  );
  return out;
}
