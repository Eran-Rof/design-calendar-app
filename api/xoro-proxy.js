// api/xoro-proxy.js — Vercel Node.js Serverless Function (60s timeout on free tier)

// maxDuration 60s (Vercel free tier max for Node.js serverless)
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  // ?app=ats routes to the ATS-specific Xoro credentials
  const app = url.searchParams.get("app");
  const XORO_API_KEY    = (app === "ats" ? process.env.VITE_XORO_ATS_KEY : process.env.VITE_XORO_API_KEY || "")?.trim();
  const XORO_API_SECRET = (app === "ats" ? process.env.VITE_XORO_ATS_SECRET : process.env.VITE_XORO_API_SECRET || "")?.trim();

  if (!XORO_API_KEY || !XORO_API_SECRET) {
    return res.status(500).json({
      error: "Xoro API credentials not configured",
      keyPresent: !!XORO_API_KEY,
      secretPresent: !!XORO_API_SECRET,
    });
  }

  const creds = Buffer.from(`${XORO_API_KEY}:${XORO_API_SECRET}`).toString("base64");
  const authHeader = `Basic ${creds}`;

  const path = url.searchParams.get("path");
  if (!path) return res.status(400).json({ error: "Missing 'path' query parameter" });

  const fetchAll = url.searchParams.get("fetch_all") === "true";

  // Base Xoro params (strip our own custom params)
  const xoroParams = new URLSearchParams(url.searchParams);
  xoroParams.delete("path");
  xoroParams.delete("fetch_all");
  xoroParams.delete("app");

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

    // ── fetch_all mode: fetch pages 1-3 in parallel, then any beyond 3 ────
    // Speculatively fetch the first 3 pages simultaneously so we never wait
    // for page 1 before starting page 2 (avoids 2× round-trip for 2-page results).
    const speculative = await Promise.allSettled([
      xoroFetchPage(1),
      xoroFetchPage(2),
      xoroFetchPage(3),
    ]);

    const page1 = speculative[0].status === "fulfilled" ? speculative[0].value : null;
    if (!page1 || !page1.Result) {
      // If Xoro returns Result:false with an empty Data array it means "no records found" — treat as success
      if (page1 && Array.isArray(page1.Data)) {
        return res.status(200).json({ Result: true, Data: page1.Data, TotalPages: page1.TotalPages ?? 0, _noResults: true });
      }
      return res.status(200).json(page1 ?? { Result: false, Message: "Page 1 fetch failed" });
    }

    const totalPages = page1.TotalPages ?? 1;
    let allData = Array.isArray(page1.Data) ? [...page1.Data] : [];

    // Collect results from speculative pages 2-3 (only up to totalPages)
    for (let i = 1; i < Math.min(speculative.length, totalPages); i++) {
      const r = speculative[i];
      if (r.status === "fulfilled" && r.value.Result && Array.isArray(r.value.Data)) {
        allData = [...allData, ...r.value.Data];
      }
    }

    // Fetch any pages beyond 3 in parallel (rare — would require 300+ records)
    if (totalPages > 3) {
      const pageNums = Array.from({ length: Math.min(totalPages, 15) - 3 }, (_, i) => i + 4);
      const rest = await Promise.allSettled(pageNums.map(p => xoroFetchPage(p)));
      for (const r of rest) {
        if (r.status === "fulfilled" && r.value.Result && Array.isArray(r.value.Data)) {
          allData = [...allData, ...r.value.Data];
        }
      }
    }

    return res.status(200).json({ Result: true, Data: allData, TotalPages: totalPages, _pagesActuallyFetched: Math.min(totalPages, 15) });

  } catch (err) {
    const msg = err.name === "AbortError"
      ? "Xoro API timed out. Try syncing with fewer filters or a specific PO number."
      : "Proxy error: " + err.message;
    return res.status(500).json({ error: msg });
  }
}
