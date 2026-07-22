// src/tanda/hooks/useItemResolver.ts
//
// Resolves a set of inventory_item_id uuids (from RMA / AR / AP document lines)
// to their SKU's { sku_code, color, size } via /api/internal/items?ids=…. Used
// by the color × size matrix views on those details — the lines themselves only
// store an opaque item id, so the grid is built by resolving each id here.

import { useEffect, useState } from "react";

export type ResolvedItem = {
  id: string;
  sku_code?: string;
  style_code?: string;
  description?: string;
  color?: string;
  size?: string;
  // The ?ids= lookup also returns inseam (jeans) — carried so the invoice/bill
  // size-matrix body can roll a uniform inseam into the style header.
  inseam?: string;
};

/**
 * Fetch item metadata for the given ids. Returns a Map keyed by item id.
 * `enabled` lets callers defer the fetch until the matrix view is actually
 * opened (avoids a network round-trip for documents the operator never expands).
 */
export function useItemResolver(ids: string[], enabled = true): {
  itemMap: Map<string, ResolvedItem>;
  loading: boolean;
} {
  const [itemMap, setItemMap] = useState<Map<string, ResolvedItem>>(new Map());
  const [loading, setLoading] = useState(false);

  // Stable key so the effect only refires when the distinct id set changes.
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");

  useEffect(() => {
    if (!enabled || !key) { setItemMap(new Map()); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/internal/items?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((arr: ResolvedItem[]) => {
        if (cancelled) return;
        const m = new Map<string, ResolvedItem>();
        if (Array.isArray(arr)) for (const it of arr) m.set(it.id, it);
        setItemMap(m);
      })
      .catch(() => { if (!cancelled) setItemMap(new Map()); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key, enabled]);

  return { itemMap, loading };
}
