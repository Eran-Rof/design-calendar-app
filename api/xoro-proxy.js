// api/xoro-proxy.js — Vercel Edge Function (30s timeout on free tier)

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const XORO_API_KEY    = process.env.VITE_XORO_API_KEY;
  const XORO_API_SECRET = process.env.VITE_XORO_API_SECRET;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (!XORO_API_KEY || !XORO_API_SECRET) {
    return new Response(JSON.stringify({
      error: "Xoro API credentials not configured",
      keyPresent: !!XORO_API_KEY,
      secretPresent: !!XORO_API_SECRET,
    }), { status: 500, headers: cors });
  }

  const creds = btoa(`${XORO_API_KEY}:${XORO_API_SECRET}`);
  const authHeader = `Basic ${creds}`;

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return new Response(JSON.stringify({ error: "Missing 'path' query parameter" }), { status: 400, headers: cors });
  }

  // Build Xoro URL with remaining params
  const xoroParams = new URLSearchParams(url.searchParams);
  xoroParams.delete("path");
  const xoroUrl = `https://res.xorosoft.io/api/xerp/${path}${xoroParams.toString() ? "?" + xoroParams.toString() : ""}`;

  try {
    // 25-second timeout to stay within Vercel's edge limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const xoroRes = await fetch(xoroUrl, {
      method: "GET",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await xoroRes.text();

    // Return debug info if error
    if (!xoroRes.ok || text.includes('"Message"')) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      return new Response(JSON.stringify({
        _debug: { url: xoroUrl, status: xoroRes.status, keyFirst8: XORO_API_KEY?.slice(0, 8) },
        ...parsed,
      }), { status: 200, headers: cors });
    }

    return new Response(text, { status: 200, headers: cors });
  } catch (err) {
    const msg = err.name === "AbortError" ? "Xoro API timed out (25s). Try syncing with fewer filters or a specific PO number." : "Proxy error: " + err.message;
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: cors });
  }
}
