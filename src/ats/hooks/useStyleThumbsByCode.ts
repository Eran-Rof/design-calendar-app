// useStyleThumbsByCode — batch-fetch primary style thumbnails keyed by style
// CODE (not style_master uuid), for the ATS grid which works off
// ip_item_master style codes. Calls /api/internal/pim/style-thumbs-by-code,
// which resolves each code → style_master.id and returns the same
// {style_id, default, byColor} shape per code. Thumbnails come live from the
// PIM, so styles gain images automatically as they're added in Tangerine.
//
// Returns Map<STYLE_CODE_UPPER, { style_id, default, byColor }>. Re-fetches
// only when the (sorted, de-duped) code set changes. Pass [] to skip the
// fetch entirely (e.g. when the IMAGES toggle is off).

import { useEffect, useRef, useState } from "react";

export interface StyleThumbByCodeInfo {
  style_id: string | null;
  default: string | null;
  byColor: Record<string, string>;
}

export function useStyleThumbsByCode(
  styleCodes: Array<string | null | undefined>,
): Map<string, StyleThumbByCodeInfo> {
  const [map, setMap] = useState<Map<string, StyleThumbByCodeInfo>>(new Map());
  const codes = Array.from(
    new Set(
      styleCodes
        .filter((s): s is string => !!s && s.trim().length > 0)
        .map((s) => s.trim().toUpperCase()),
    ),
  ).sort();
  const key = codes.join(",");
  const last = useRef<string>("");

  useEffect(() => {
    if (key === last.current) return;
    last.current = key;
    if (codes.length === 0) { setMap(new Map()); return; }
    let cancelled = false;
    fetch("/api/internal/pim/style-thumbs-by-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ style_codes: codes }),
    })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: Record<string, StyleThumbByCodeInfo>) => {
        if (cancelled) return;
        const m = new Map<string, StyleThumbByCodeInfo>();
        for (const code of Object.keys(d || {})) m.set(code, d[code]);
        setMap(m);
      })
      .catch(() => { /* non-fatal — thumbnails just stay blank */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}
