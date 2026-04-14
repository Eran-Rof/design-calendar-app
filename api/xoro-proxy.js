// api/xoro-proxy.js — Vercel Node.js Serverless Function

// Pro plan: headroom for a single paginated fetch (up to 50 pages).
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const XORO_API_KEY    = process.env.VITE_XORO_API_KEY;
  const XORO_API_SECRET = process.env.VITE_XORO_API_SECRET;

  if (!XORO_API_KEY || !XORO_API_SECRET) {
    return res.status(500).json({
      error: "Xoro API credentials not configured",
      keyPresent: !!XORO_API_KEY,
      secretPresent: !!XORO_API_SECRET,
    });
  }

  const creds = Buffer.from(`${XORO_API_KEY}:${XORO_API_SECRET}`).toString("base64");
  const authHeader = `Basic ${creds}`;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path");
  if (!path) return res.status(400).json({ error: "Missing 'path' query parameter" });

  const fetchAll = url.searchParams.get("fetch_all") === "true";

  // Base Xoro params (strip our own custom params)
  const xoroParams = new URLSearchParams(url.searchParams);
  xoroParams.delete("path");
  xoroParams.delete("fetch_all");

  async function xoroFetchPage(page) {
    const p = new URLSearchParams(xoroParams);
    p.set("page", String(page));
    const xoroUrl = `https://res.xorosoft.io/api/xerp/${path}?${p.toString()}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 50000);
    try {
      const r = await fetch(xoroUrl, {
        method: "GET",
        headers: { "Authorization": authHeader, "Content-Type": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const text = await r.text();
      try { return JSON.parse(text); } catch {
        return { Result: false, Message: "Non-JSON from Xoro", raw: text.slice(0, 300) };
      }
    } catch (err) {
      clearTimeout(t);
      throw err;
    }
  }

  try {
    if (!fetchAll) {
      // ── Single-page mode (original behaviour) ────────────────────────────
      const xoroUrl = `https://res.xorosoft.io/api/xerp/${path}${xoroParams.toString() ? "?" + xoroParams.toString() : ""}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 55000);
      const xoroRes = await fetch(xoroUrl, {
        method: "GET",
        headers: { "Authorization": authHeader, "Content-Type": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await xoroRes.text();
      if (!xoroRes.ok || text.includes('"Message"')) {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        return res.status(200).json({
          _debug: { url: xoroUrl, status: xoroRes.status, keyFirst8: XORO_API_KEY?.slice(0, 8) },
          ...parsed,
        });
      }
      try {
        return res.status(200).json(JSON.parse(text));
      } catch {
        return res.status(502).json({ error: "Xoro returned a non-JSON response (possible rate limit or auth redirect)", raw: text.slice(0, 300) });
      }
    }

    // ── fetch_all mode: sequential pagination with retries ──────────────
    // Parallel speculative fetches tripped Xoro rate limits (confirmed via
    // ats-sync.js BATCH=3 comment). Go sequential; each page retries with
    // backoff when Xoro rate-limits (Result:false + empty Data on page 1
    // with no data yet accumulated usually means throttling, not truly empty).
    const pageCounts = [];
    let allData = [];
    let reportedTotalPages = 1;

    async function fetchPageWithRetry(page, isFirstPage) {
      const delays = isFirstPage ? [0, 800, 2000] : [0];
      let last;
      for (const delay of delays) {
        if (delay) await new Promise(r => setTimeout(r, delay));
        last = await xoroFetchPage(page);
        const hasData = Array.isArray(last?.Data) && last.Data.length > 0;
        if (hasData) return last;
        // On the first page only, retry on Result:false (likely throttled).
        if (!isFirstPage || last?.Result !== false) return last;
      }
      return last;
    }

    for (let page = 1; page <= 50; page++) {
      let r;
      try {
        r = await fetchPageWithRetry(page, page === 1);
      } catch (err) {
        pageCounts.push({ page, error: String(err?.message || err) });
        break;
      }
      const dataLen = Array.isArray(r?.Data) ? r.Data.length : -1;
      pageCounts.push({ page, result: r?.Result, dataLen, totalPages: r?.TotalPages });
      if (page === 1) {
        reportedTotalPages = r?.TotalPages ?? 1;
        if (!Array.isArray(r?.Data)) {
          return res.status(200).json(r ?? { Result: false, Message: "Page 1 fetch failed" });
        }
      }
      if (dataLen <= 0) break;
      allData = [...allData, ...r.Data];
    }

    return res.status(200).json({ Result: true, Data: allData, TotalPages: reportedTotalPages, _recordsReturned: allData.length, _pageCounts: pageCounts, _status: xoroParams.get("status") });

  } catch (err) {
    const msg = err.name === "AbortError"
      ? "Xoro API timed out. Try syncing with fewer filters or a specific PO number."
      : "Proxy error: " + err.message;
    return res.status(500).json({ error: msg });
  }
}
