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
import { demoEarlyExit, demoStubKind } from "./_lib/demoGuard.js";
import { rbacObserve, rbacEnforce, rbacMode } from "./_lib/rbac/index.js";
import { brandObserve } from "./_lib/brandContext.js";
import { captureError } from "./_lib/errorCapture.js";

// Bumped from 60s → 300s. Several inner handlers (parse-excel,
// xoro-proxy, ats-supply-sync, tanda-pos-sync, xoro-sales-sync,
// xoro-items-missing-sync) declared their own 300s maxDuration but
// were silently capped at 60s because Vercel reads the outer
// dispatcher's config — not the inner handler's — at execution time.
// 300s matches the Pro plan ceiling and the longest-running handlers.
export const config = { maxDuration: 300 };

// Compile once per cold start
const COMPILED = compileRoutes(ROUTES);

// Security sprint (re-rate 2026-07-08): individual handlers historically set
// `Access-Control-Allow-Origin: *`, which lets any website script drive the
// API from a victim's browser. Rather than edit ~700 handlers, the dispatcher
// clamps the header centrally: res.setHeader is wrapped so ANY attempt to set
// Access-Control-Allow-Origin is rewritten to the request's origin when that
// origin is allowlisted, else to the primary app origin (which makes the
// response unreadable cross-origin). Server-to-server callers (webhooks, EDI,
// crons) are unaffected — CORS only constrains browsers.
const CORS_ALLOWED = new Set([
  "https://apps.ringoffire.com",
  "https://design-calendar-app.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
]);
const VERCEL_PREVIEW_RE = /^https:\/\/design-calendar-app-[a-z0-9]+-[a-z0-9-]+\.vercel\.app$/;

export function resolveCorsOrigin(origin) {
  const o = String(origin || "");
  if (CORS_ALLOWED.has(o) || VERCEL_PREVIEW_RE.test(o)) return o;
  return "https://apps.ringoffire.com";
}

function clampCors(req, res) {
  const value = resolveCorsOrigin(req.headers.origin);
  const orig = res.setHeader.bind(res);
  res.setHeader = (name, v) => {
    if (String(name).toLowerCase() === "access-control-allow-origin") {
      return orig(name, value);
    }
    return orig(name, v);
  };
  // Handlers that never set CORS still get a correct, clamped header.
  orig("Access-Control-Allow-Origin", value);
  orig("Vary", "Origin");
}

export default async function handler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  // After a rewrite, req.url reflects the rewritten path (`/api/dispatch`),
  // so we prefer the original forwarded via `__fullpath` query param set by
  // vercel.json's rewrite rule. Fall back to url.pathname for direct hits.
  const rawPath = url.searchParams.get("__fullpath");
  const pathname = rawPath || url.pathname;

  // Demo-mode short-circuit. Centralised here so individual handlers don't
  // each need to import demoGuard. Stubs all routes that would contact
  // Xoro / Searates / Resend / Supabase Auth invite.
  const stubKind = demoStubKind(pathname);
  if (stubKind && demoEarlyExit(req, res, stubKind)) return;

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

    // Clamp CORS before the handler runs so its own setHeader calls are wrapped.
    clampCors(req, res);

    // P14 RBAC. Default (RBAC_MODE unset) = no-op. `log` = observe + warn on a
    // would-deny. `enforce` = reject with 403 when an authenticated caller lacks
    // the permission; fail-open on legacy anon-key callers. `strict` = same as
    // enforce PLUS reject unauthenticated callers with 401 on mapped routes —
    // flip to strict only after every operator is on MS-OAuth. All paths are
    // internally wrapped.
    const _rbacMode = rbacMode();
    if (_rbacMode === "enforce" || _rbacMode === "strict") {
      if (await rbacEnforce(req, res, pathname, req.method)) return; // 401/403 already sent
    } else if (_rbacMode === "log") {
      await rbacObserve(req, pathname, req.method).catch(() => {});
    }

    // P15 Brand Master C2 — silent-log brand/channel context observability.
    // No-op unless BRAND_SCOPE_MODE is set; never filters/blocks (chunk 2).
    brandObserve(req, pathname, req.method);

    try {
      return await route.handler(req, res);
    } catch (err) {
      // Protect the dispatcher from unhandled throws in a specific handler
      // eslint-disable-next-line no-console
      console.error(`Handler error on ${pathname}:`, err);
      // Persist to app_errors so the daily digest surfaces it (Vercel logs
      // alone are write-only in practice). Awaited: we're already on the
      // error path, and fire-and-forget can be frozen with the lambda.
      await captureError({
        source: "api",
        route: pathname,
        method: req.method,
        message: err?.message || String(err),
        stack: err?.stack,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "Handler error", detail: err?.message || String(err) });
      }
      return;
    }
  }

  res.status(404).json({ error: `No route for ${pathname}` });
}
