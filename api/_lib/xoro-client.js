// api/_lib/xoro-client.js
//
// Thin, server-side Xoro fetch helper used by the planning integration
// routes under api/xoro/*. Separate from api/xoro-proxy.js (which is the
// legacy catch-all called directly from the browser for the TandA app)
// so we can evolve the planning ingest path without touching that tool.
//
// Design:
//   • Credentials come from env. We never accept a caller-supplied key.
//   • A Xoro call succeeds when the envelope reports Result:true; we
//     surface Message for everything else and let the caller decide how
//     to report it.
//   • fetchXoroAll paginates sequentially with retries — the same
//     throttling behaviour documented in xoro-proxy.js.

// Xoro provisions per-Private-App credentials (each app has its own
// permission scope). Pass `module: "sales" | "items" | "bill"` to use
// VITE_XORO_<MODULE>_API_KEY/SECRET; falls back to the default
// VITE_XORO_API_KEY pair when an app-specific pair isn't set.
//
// Mapping (see .env.local.example for the canonical version):
//   default → "PO To ASN Workflow"      → purchaseorder/getpurchaseorder
//   items   → "ATS App"                 → salesorder/getsalesorder
//   sales   → "Sales History"           → invoice/getinvoice
//   bill    → "Bill & Item Receipt Mgmt" → bill/getbill, bill/getitemreceipt
export function xoroCredsFromEnv(module) {
  const prefix =
    module === "sales" ? "VITE_XORO_SALES_" :
    module === "items" ? "VITE_XORO_ITEMS_" :
    module === "bill"  ? "VITE_XORO_BILL_"  :
    "VITE_XORO_";
  const key = process.env[`${prefix}API_KEY`] || process.env.VITE_XORO_API_KEY;
  const secret = process.env[`${prefix}API_SECRET`] || process.env.VITE_XORO_API_SECRET;
  if (!key || !secret) {
    return { ok: false, error: "XORO_CREDENTIALS_MISSING", keyPresent: !!key, secretPresent: !!secret, module: module ?? "default" };
  }
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  return { ok: true, authHeader: `Basic ${basic}` };
}

async function xoroFetchPage({ path, params, page, authHeader }) {
  const p = new URLSearchParams(params);
  p.set("page", String(page));
  const url = `https://res.xorosoft.io/api/xerp/${path}?${p.toString()}`;
  const ctrl = new AbortController();
  // 90s per attempt: page 17 in production timed out at 60s — the SOs
  // on that page were Macy's-sized (hundreds of line items), pushing
  // Xoro's response past 60s. With per_page=100 and a 90s ceiling we
  // cover the heavy-tail pages without exceeding Vercel's 300s
  // function cap on the retry chain (90 + 0.8 + 90 + 2 + 90 = ~273s).
  const t = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, body: JSON.parse(text), url }; }
    catch { return { ok: false, status: r.status, body: { Result: false, Message: "Non-JSON", raw: text.slice(0, 300) }, url }; }
  } catch (err) {
    clearTimeout(t);
    return { ok: false, status: 0, body: { Result: false, Message: String(err?.message || err) }, url };
  }
}

export async function fetchXoro({ path, params = {}, module }) {
  const creds = xoroCredsFromEnv(module);
  if (!creds.ok) return { ok: false, status: 500, body: { error: creds.error, keyPresent: creds.keyPresent, secretPresent: creds.secretPresent } };
  return xoroFetchPage({ path, params, page: 1, authHeader: creds.authHeader });
}

export async function fetchXoroAll({ path, params = {}, maxPages = 50, module, pageStart = 1 }) {
  const creds = xoroCredsFromEnv(module);
  if (!creds.ok) return { ok: false, status: 500, body: { error: creds.error } };

  // 2 retries (3 total attempts) instead of 4 — at 30s per attempt, the
  // longer chain would compound to ~3 minutes per flaky page. Most
  // Xoro 5xx blips are transient and the first retry fixes them.
  const delays = [0, 800, 2000];
  let all = [];
  let totalPages = 1;
  const pageNotes = [];

  // Iterate from pageStart for `maxPages` consecutive pages so callers can
  // chunk huge catalogs across multiple invocations (e.g. 20k items at
  // 500/page = 40 pages → 8 calls of pageStart=1,6,11,…).
  for (let i = 0; i < maxPages; i++) {
    const page = pageStart + i;
    let attempt;
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      attempt = await xoroFetchPage({ path, params, page, authHeader: creds.authHeader });
      const dataLen = Array.isArray(attempt.body?.Data) ? attempt.body.Data.length : -1;
      // Success: got data on this page → done retrying.
      if (dataLen > 0) break;
      // 4xx (auth/path/permission): retrying won't help, bail immediately.
      if (attempt.status >= 400 && attempt.status < 500) break;
      // Empty page on a clean 200 with Result:true is a legitimate
      // "no more rows" — done retrying. Used as the page-walk
      // termination signal further down.
      if (attempt.body?.Result === true) break;
      // Otherwise (HTTP 5xx with `{Message:"An error has occurred."}`
      // and no Result, or explicit Result:false) keep retrying. Xoro
      // 500s intermittently and we'd rather pay 0+0.8+2+4 = ~7s extra
      // on a flaky page than crash the whole walk.
    }
    const dataLen = Array.isArray(attempt.body?.Data) ? attempt.body.Data.length : -1;
    pageNotes.push({ page, result: attempt.body?.Result, dataLen, totalPages: attempt.body?.TotalPages });
    if (i === 0) {
      totalPages = attempt.body?.TotalPages ?? 1;
      if (!Array.isArray(attempt.body?.Data)) {
        return { ok: false, status: attempt.status || 502, body: attempt.body, pages: pageNotes };
      }
    }
    if (dataLen <= 0) break;
    all = all.concat(attempt.body.Data);
    if (page >= totalPages) break;
  }

  return {
    ok: true,
    status: 200,
    body: { Result: true, Data: all, TotalPages: totalPages, _recordsReturned: all.length, _pageCounts: pageNotes },
  };
}
