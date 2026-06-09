// StyleThumb + useStyleThumbs — a small style image thumbnail for any "styles
// view", with the same look & feel as the Inventory Matrix (44px rounded).
// Clicking it opens the full image gallery (openStyleGallery).
//
// Usage in a list:
//   const thumbs = useStyleThumbs(rows.map(r => r.id));
//   <StyleThumb styleId={r.id} label={r.style_code}
//               url={thumbs.get(r.id)?.byColor[colorKey] ?? thumbs.get(r.id)?.default} />

import { useEffect, useRef, useState } from "react";
import { openStyleGallery } from "./StyleImageGallery";

export interface StyleThumbInfo { default: string | null; byColor: Record<string, string> }

/**
 * Batch-fetch primary thumbnails for a set of style ids in ONE request.
 * Returns Map<styleId, {default, byColor}>. Re-fetches when the id set changes.
 */
export function useStyleThumbs(styleIds: Array<string | null | undefined>): Map<string, StyleThumbInfo> {
  const [map, setMap] = useState<Map<string, StyleThumbInfo>>(new Map());
  const ids = Array.from(new Set(styleIds.filter((s): s is string => !!s))).sort();
  const key = ids.join(",");
  const last = useRef<string>("");

  useEffect(() => {
    if (key === last.current) return;
    last.current = key;
    if (ids.length === 0) { setMap(new Map()); return; }
    let cancelled = false;
    fetch("/api/internal/pim/style-thumbs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ style_ids: ids }),
    })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: Record<string, StyleThumbInfo>) => {
        if (cancelled) return;
        const m = new Map<string, StyleThumbInfo>();
        for (const id of Object.keys(d || {})) m.set(id, d[id]);
        setMap(m);
      })
      .catch(() => { /* non-fatal — thumbnails just stay blank */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}

/** 44px style thumbnail; click opens the gallery. Matches the Inventory Matrix. */
export function StyleThumb({ styleId, label, url, size = 44 }: { styleId: string; label?: string; url?: string | null; size?: number }) {
  if (!url) {
    return <span style={{ display: "block", width: size, height: size, background: "#1E293B", borderRadius: 4, margin: "0 auto" }} />;
  }
  return (
    <img
      src={url}
      alt={label || ""}
      title="View all images for this style"
      onClick={(e) => { e.stopPropagation(); openStyleGallery(styleId, label || styleId); }}
      style={{ width: size, height: size, objectFit: "cover", borderRadius: 4, border: "1px solid #334155", cursor: "pointer", display: "block", margin: "0 auto" }}
    />
  );
}
