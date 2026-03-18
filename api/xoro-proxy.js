// api/xoro-proxy.js — Vercel serverless function
// Proxies requests to Xoro API to avoid CORS issues in the browser

export const config = { runtime: "nodejs18.x" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

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

  // Parse query params from the URL string directly
  const urlStr = req.url || "";
  const qIndex = urlStr.indexOf("?");
  const queryStr = qIndex >= 0 ? urlStr.slice(qIndex + 1) : "";
  const params = new URLSearchParams(queryStr);

  const path = params.get("path");
  if (!path) {
    return res.status(400).json({ error: "Missing 'path' query parameter" });
  }
  params.delete("path");

  const xoroUrl = `https://res.xorosoft.io/api/xerp/${path}${params.toString() ? "?" + params.toString() : ""}`;

  console.log("Calling Xoro URL:", xoroUrl);
  console.log("Key present:", !!XORO_API_KEY, "Secret present:", !!XORO_API_SECRET);

  try {
    const xoroRes = await fetch(xoroUrl, {
      method: "GET",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
      },
    });

    const text = await xoroRes.text();
    console.log("Xoro response status:", xoroRes.status);
    console.log("Xoro response:", text.slice(0, 300));

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    return res.status(xoroRes.status).json(data);
  } catch (err) {
    console.error("Proxy fetch error:", err.message);
    return res.status(500).json({ error: "Proxy error: " + err.message });
  }
}
