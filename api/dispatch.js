// api/dispatch.js — single catch-all dispatcher for every /api/* route.
//
// Background: Vercel counts every file under api/ (sans `_*`) as an
// individual serverless function. With 200+ endpoints, we were blowing
// past the Pro plan's function cap, causing silent drops (onboarding etc.
// got served as static source instead of executing).
//
// Solution: all handler modules now live under api/_handlers/ (the
// underscore makes Vercel skip them). This file is the only function
// Vercel sees. vercel.json rewrites every `/api/*` request here and
// passes the original path via the `__fullpath` query param. The
// dispatcher then matches the original path against the routing table
// and delegates to the right handler.

import { ROUTES, compileRoutes } from "./_handlers/routes.js";

export const config = { maxDuration: 60 };

// Compile once per cold start
const COMPILED = compileRoutes(ROUTES);

export default async function handler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  // After a rewrite, req.url reflects the rewritten path (`/api/dispatch`),
  // so we prefer the original forwarded via `__fullpath` query param set by
  // vercel.json's rewrite rule. Fall back to url.pathname for direct hits.
  const rawPath = url.searchParams.get("__fullpath");
  const pathname = rawPath || url.pathname;

  for (const route of COMPILED) {
    const match = route.regex.exec(pathname);
    if (!match) continue;

    // Merge path params into req.query so existing handlers using
    // req.query.id / req.query.vendor_id / etc. continue to work.
    const params = {};
    for (let i = 0; i < route.params.length; i++) {
      params[route.params[i]] = decodeURIComponent(match[i + 1]);
    }
    req.query = { ...(req.query || {}), ...params };

    try {
      return await route.handler(req, res);
    } catch (err) {
      // Protect the dispatcher from unhandled throws in a specific handler
      // eslint-disable-next-line no-console
      console.error(`Handler error on ${pathname}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Handler error", detail: err?.message || String(err) });
      }
      return;
    }
  }

  res.status(404).json({ error: `No route for ${pathname}` });
}
