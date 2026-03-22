// api/xoro-proxy.js — Vercel Node.js Serverless Function (60s timeout on free tier)

// maxDuration 60s (Vercel free tier max for Node.js serverless)
export const config = { maxDuration: 60 };

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

  // Build Xoro URL with remaining params
  const xoroParams = new URLSearchParams(url.searchParams);
  xoroParams.delete("path");
  const xoroUrl = `https://res.xorosoft.io/api/xerp/${path}${xoroParams.toString() ? "?" + xoroParams.toString() : ""}`;

  try {
    // 55-second timeout — leaves 5s buffer before Vercel's 60s limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    const xoroRes = await fetch(xoroUrl, {
      method: "GET",
      headers: { "Authorization": authHeader, "Content-Type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await xoroRes.text();

    // Return debug info if error
    if (!xoroRes.ok || text.includes('"Message"')) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      return res.status(200).json({
        _debug: { url: xoroUrl, status: xoroRes.status, keyFirst8: XORO_API_KEY?.slice(0, 8) },
        ...parsed,
      });
    }

    // Parse and return
    try {
      return res.status(200).json(JSON.parse(text));
    } catch {
      return res.status(200).send(text);
    }
  } catch (err) {
    const msg = err.name === "AbortError"
      ? "Xoro API timed out (55s). Try syncing with fewer filters or a specific PO number."
      : "Proxy error: " + err.message;
    return res.status(500).json({ error: msg });
  }
}
