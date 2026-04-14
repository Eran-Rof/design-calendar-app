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

    // ── fetch_all mode: sequential pagination ───────────────────────────
    // Parallel speculative fetches were tripping Xoro rate limits (confirmed
    // against ats-sync.js comment: >3 concurrent → rate-limited). Go strictly
    // sequential: page 1, 2, 3, ... until we see an empty page or hit the cap.
    // Trust Data.length, not the unreliable Result/TotalPages fields.
    const pageCounts = [];
    let allData = [];
    let reportedTotalPages = 1;
    for (let page = 1; page <= 50; page++) {
      let r;
      try {
        r = await xoroFetchPage(page);
      } catch (err) {
        pageCounts.push({ page, error: String(err?.message || err) });
        break;
      }
      const dataLen = Array.isArray(r?.Data) ? r.Data.length : -1;
      pageCounts.push({ page, result: r?.Result, dataLen, totalPages: r?.TotalPages });
      if (page === 1) {
        reportedTotalPages = r?.TotalPages ?? 1;
        if (!Array.isArray(r?.Data)) {
          // Page 1 with no Data array — return the raw Xoro response so the
          // caller can see what happened (auth error, bad status value, etc).
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
