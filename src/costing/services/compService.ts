// Costing Module — comp aggregation client
//
// Thin POST wrappers around /api/internal/costing/comp/ly and /comp/t3.
// Both return Record<style_code, CompResult>. See src/costing/types.ts for
// the CompResult shape and PPK guard semantics (comp_grain_warning).
//
// Backed by handlers h489 (ly) + h490 (t3) per routes.js.

import type { CompResultMap, CompWindow } from "../types";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      if (errBody?.error) msg = errBody.error;
    } catch { /* noop */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch LY (last-year) comp aggregates for a batch of style codes.
 *
 * @param styleCodes  array of style_code strings (deduped server-side)
 * @param window      optional window override. If omitted, the server
 *                    defaults to the trailing 365 days shifted back 12
 *                    months (same calendar slice, one year ago).
 *                    If provided, BOTH endpoints of the supplied window
 *                    are shifted back 12 months by the server.
 */
export function fetchLyComp(
  styleCodes: string[],
  window?: CompWindow,
): Promise<CompResultMap> {
  if (!Array.isArray(styleCodes) || styleCodes.length === 0) {
    return Promise.resolve({});
  }
  const body: { style_codes: string[]; window?: CompWindow } = {
    style_codes: styleCodes,
  };
  if (window) body.window = window;
  return postJson<CompResultMap>("/api/internal/costing/comp/ly", body);
}

/**
 * Fetch trailing-3-month comp aggregates for a batch of style codes.
 * Window is fixed server-side: today − 3 calendar months → today.
 */
export function fetchT3Comp(styleCodes: string[]): Promise<CompResultMap> {
  if (!Array.isArray(styleCodes) || styleCodes.length === 0) {
    return Promise.resolve({});
  }
  return postJson<CompResultMap>("/api/internal/costing/comp/t3", {
    style_codes: styleCodes,
  });
}
