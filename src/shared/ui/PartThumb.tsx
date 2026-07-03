// PartThumb + usePartThumbs — a small part image thumbnail for any "parts view"
// (Part Master list, BOM editor, build detail). Mirrors StyleThumb but keyed to
// part_master. Clicking opens the full image in a new tab (no gallery needed).
//
// Usage in a list:
//   const thumbs = usePartThumbs(rows.map(r => r.id));
//   <PartThumb partId={r.id} url={thumbs.get(r.id) ?? null} label={r.code} />

import { useEffect, useRef, useState } from "react";

/**
 * Batch-fetch primary thumbnails for a set of part ids in ONE request.
 * Returns Map<partId, url>. Re-fetches when the id set changes.
 */
export function usePartThumbs(partIds: Array<string | null | undefined>): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(new Map());
  const ids = Array.from(new Set(partIds.filter((s): s is string => !!s))).sort();
  const key = ids.join(",");
  const last = useRef<string>("");

  useEffect(() => {
    if (key === last.current) return;
    last.current = key;
    if (ids.length === 0) { setMap(new Map()); return; }
    let cancelled = false;
    fetch("/api/internal/part-thumbs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ part_ids: ids }),
    })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: Record<string, string | null>) => {
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const id of Object.keys(d || {})) { const u = d[id]; if (u) m.set(id, u); }
        setMap(m);
      })
      .catch(() => { /* non-fatal — thumbnails just stay blank */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}

/** Small part thumbnail; click opens the full image in a new tab. */
export function PartThumb({ partId, url, label, size = 44 }: { partId?: string; url?: string | null; label?: string; size?: number }) {
  void partId;
  if (!url) {
    return <span style={{ display: "block", width: size, height: size, background: "#1E293B", borderRadius: 4, margin: "0 auto" }} />;
  }
  return (
    <img
      src={url}
      alt={label || ""}
      title="Open full image"
      onClick={(e) => { e.stopPropagation(); window.open(url, "_blank", "noopener,noreferrer"); }}
      style={{ width: size, height: size, objectFit: "cover", borderRadius: 4, border: "1px solid #334155", cursor: "pointer", display: "block", margin: "0 auto" }}
    />
  );
}
