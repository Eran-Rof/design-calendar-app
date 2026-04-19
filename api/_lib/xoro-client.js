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

export function xoroCredsFromEnv() {
  const key = process.env.VITE_XORO_API_KEY;
  const secret = process.env.VITE_XORO_API_SECRET;
  if (!key || !secret) {
    return { ok: false, error: "XORO_CREDENTIALS_MISSING", keyPresent: !!key, secretPresent: !!secret };
  }
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  return { ok: true, authHeader: `Basic ${basic}` };
}

async function xoroFetchPage({ path, params, page, authHeader }) {
  const p = new URLSearchParams(params);
  p.set("page", String(page));
  const url = `https://res.xorosoft.io/api/xerp/${path}?${p.toString()}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 50_000);
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

export async function fetchXoro({ path, params = {} }) {
  const creds = xoroCredsFromEnv();
  if (!creds.ok) return { ok: false, status: 500, body: { error: creds.error, keyPresent: creds.keyPresent, secretPresent: creds.secretPresent } };
  return xoroFetchPage({ path, params, page: 1, authHeader: creds.authHeader });
}

export async function fetchXoroAll({ path, params = {}, maxPages = 50 }) {
  const creds = xoroCredsFromEnv();
  if (!creds.ok) return { ok: false, status: 500, body: { error: creds.error } };

  const delays = [0, 800, 2000, 4000];
  let all = [];
  let totalPages = 1;
  const pageNotes = [];

  for (let page = 1; page <= maxPages; page++) {
    let attempt;
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      attempt = await xoroFetchPage({ path, params, page, authHeader: creds.authHeader });
      const dataLen = Array.isArray(attempt.body?.Data) ? attempt.body.Data.length : -1;
      if (dataLen > 0) break;
      if (attempt.body?.Result !== false) break;
    }
    const dataLen = Array.isArray(attempt.body?.Data) ? attempt.body.Data.length : -1;
    pageNotes.push({ page, result: attempt.body?.Result, dataLen, totalPages: attempt.body?.TotalPages });
    if (page === 1) {
      totalPages = attempt.body?.TotalPages ?? 1;
      if (!Array.isArray(attempt.body?.Data)) {
        return { ok: false, status: attempt.status || 502, body: attempt.body, pages: pageNotes };
      }
    }
    if (dataLen <= 0) break;
    all = all.concat(attempt.body.Data);
  }

  return {
    ok: true,
    status: 200,
    body: { Result: true, Data: all, TotalPages: totalPages, _recordsReturned: all.length, _pageCounts: pageNotes },
  };
}
