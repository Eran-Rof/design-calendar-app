// Costing Module — useLyComp hook
//
// Exposes a manual `fetch` action so the grid (Chunk 4) can request LY comp
// aggregates after a style is picked / on demand from a "Refresh comp"
// button. We intentionally do NOT auto-fire on mount or on style change —
// the consumer decides when to spend the round-trip.
//
// Holds the last fetched response in `data` so consumers can render
// directly without re-fetching when the same style codes are passed again.

import { useCallback, useRef, useState } from "react";
import { fetchLyComp } from "../services/compService";
import type { CompResultMap, CompWindow } from "../types";

export interface UseLyCompResult {
  data: CompResultMap;
  loading: boolean;
  error: string | null;
  fetch: (style_codes: string[], window?: CompWindow) => Promise<CompResultMap>;
  reset: () => void;
}

export function useLyComp(): UseLyCompResult {
  const [data, setData] = useState<CompResultMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track latest in-flight fetch so we ignore late responses if the consumer
  // refires while a previous call is still pending.
  const reqIdRef = useRef(0);

  const doFetch = useCallback(async (style_codes: string[], window?: CompWindow) => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchLyComp(style_codes, window);
      if (reqIdRef.current === myReq) {
        // Merge so consumers that call multiple times keep prior style data.
        setData((prev) => ({ ...prev, ...result }));
        setLoading(false);
      }
      return result;
    } catch (e) {
      if (reqIdRef.current === myReq) {
        setError((e as Error).message);
        setLoading(false);
      }
      throw e;
    }
  }, []);

  const reset = useCallback(() => {
    reqIdRef.current++;
    setData({});
    setError(null);
    setLoading(false);
  }, []);

  return { data, loading, error, fetch: doFetch, reset };
}
