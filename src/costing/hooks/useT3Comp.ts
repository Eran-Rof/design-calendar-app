// Costing Module — useT3Comp hook
//
// Manual-fetch hook for trailing-3-month comp aggregates. Same shape as
// useLyComp — caller decides when to fire.

import { useCallback, useRef, useState } from "react";
import { fetchT3Comp } from "../services/compService";
import type { CompResultMap } from "../types";

export interface UseT3CompResult {
  data: CompResultMap;
  loading: boolean;
  error: string | null;
  fetch: (style_codes: string[]) => Promise<CompResultMap>;
  reset: () => void;
}

export function useT3Comp(): UseT3CompResult {
  const [data, setData] = useState<CompResultMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const doFetch = useCallback(async (style_codes: string[]) => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchT3Comp(style_codes);
      if (reqIdRef.current === myReq) {
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
