// api/xoro-proxy.js — Vercel serverless function
// Proxies requests to Xoro API to avoid CORS issues in the browser
// Deploy this file to: api/xoro-proxy.js in your project root

export default async function handler(req, res) {
  // Allow requests from your app
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const XORO_API_KEY    = process.env.VITE_XORO_API_KEY;
  const XORO_API_SECRET = process.env.VITE_XORO_API_SECRET;

  if (!XORO_API_KEY || !XORO_API_SECRET) {
    return res.status(500).json({ error: "Xoro API credentials not configured" });
  }

  // Build Basic auth header
  const creds = Buffer.from(`${XORO_API_KEY}:${XORO_API_SECRET}`).toString("base64");
  const authHeader = `Basic ${creds}`;

  // Get the endpoint path from query param, e.g. ?path=purchaseorder&page=1
  const { path, ...rest } = req.query;
  if (!path) {
    return res.status(400).json({ error: "Missing 'path' query parameter" });
  }

  // Build Xoro URL with all remaining query params
  const params = new URLSearchParams(rest).toString();
  const xoroUrl = `https://res.xorosoft.io/api/xerp/${path}${params ? "?" + params : ""}`;

  try {
    const xoroRes = await fetch(xoroUrl, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
      },
      ...(req.method === "POST" && req.body
        ? { body: JSON.stringify(req.body) }
        : {}),
    });

    const data = await xoroRes.json();
    return res.status(xoroRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Proxy error: " + err.message });
  }
}
